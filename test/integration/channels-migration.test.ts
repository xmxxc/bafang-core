import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createDb, migrateSchema, MIGRATIONS_FOLDER } from '../../src/db';
import type { EmailLoginResponse } from '../../src/routes/auth';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

async function migrationFolderThrough(maxIdx: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `channels-migrations-${maxIdx}-`));
  const sourceMeta = join(MIGRATIONS_FOLDER, 'meta');
  await mkdir(join(folder, 'meta'));
  const journal = JSON.parse(await readFile(join(sourceMeta, '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= maxIdx);
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
  for (const entry of journal.entries) {
    await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  for (const name of await readdir(sourceMeta)) {
    if (name.endsWith('.json') && name !== '_journal.json') {
      const snapshot = Number(name.slice(0, 4));
      if (snapshot <= maxIdx) await copyFile(join(sourceMeta, name), join(folder, 'meta', name));
    }
  }
  return folder;
}

async function loggedInApp(db: TestSchema) {
  let code = '';
  const app = createApp({
    database: createDb(db.pool),
    mailer: {
      async sendVerificationCode(_email, sentCode) {
        code = sentCode;
      },
    },
  });
  const email = `migration-${randomUUID()}@example.com`;
  const request = await app.request('/v1/auth/email/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(request.status).toBe(200);
  const login = await app.request('/v1/auth/email/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code, device: 'miniprogram' }),
  });
  expect(login.status).toBe(200);
  const token = ((await login.json()) as EmailLoginResponse).token;
  expect(token).toBeTruthy();
  return { app, headers: { Authorization: `Bearer ${token}` } };
}

it('preserves existing users preset order when upgrading from migration 0003, observed over HTTP', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'channels-migrations-'));
  let db: TestSchema | undefined;
  try {
    // 只准备旧版迁移环境，所有业务状态仍由 HTTP 创建、观察。
    const journal = JSON.parse(
      await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
    ) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 3);
    await mkdir(join(folder, 'meta'));
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) {
      await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    db = await createTestSchema(folder);
    let code = '';
    const app = createApp({
      database: createDb(db.pool),
      mailer: {
        async sendVerificationCode(_email, sentCode) {
          code = sentCode;
        },
      },
    });
    const email = 'existing@example.com';
    expect(
      (
        await app.request('/v1/auth/email/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        })
      ).status,
    ).toBe(200);
    const login = await app.request('/v1/auth/email/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, device: 'miniprogram' }),
    });
    expect(login.status).toBe(200);
    const headers = {
      Authorization: `Bearer ${((await login.json()) as EmailLoginResponse).token}`,
    };
    const before = await (await app.request('/v1/channels', { headers })).json();
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    // 重复迁移也是幂等的，不会重置渠道或顺序。
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    const after = await app.request('/v1/channels', { headers });
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual(before);
    const added = await app.request('/v1/channels', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '迁移后新增' }),
    });
    expect(added.status).toBe(201);
    const listed = await app.request('/v1/channels', { headers });
    expect(
      ((await listed.json()) as { items: { name: string }[] }).items.map((channel) => channel.name),
    ).toEqual(['支付宝', '天天基金', '未指定', '迁移后新增']);
    const duplicate = await app.request('/v1/channels', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '支付宝' }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: 'channel_name_conflict' } });
  } finally {
    if (db) await dropTestSchema(db);
    await rm(folder, { recursive: true, force: true });
  }
});

it('applies the 0006 unique index when upgrading a schema already migrated through 0005', async () => {
  const prior = await migrationFolderThrough(5);
  const db = await createTestSchema(prior);
  try {
    const { app, headers } = await loggedInApp(db);
    const first = await app.request('/v1/channels', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '迁移唯一性检查' }),
    });
    expect(first.status).toBe(201);
    await migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema);
    const duplicate = await app.request('/v1/channels', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '迁移唯一性检查' }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: { code: 'channel_name_conflict' },
    });
  } finally {
    await dropTestSchema(db);
    await rm(prior, { recursive: true, force: true });
  }
});

it('fails clearly instead of silently skipping 0006 when existing data violates its unique index', async () => {
  const prior = await migrationFolderThrough(5);
  const db = await createTestSchema(prior);
  try {
    const { app, headers } = await loggedInApp(db);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const duplicate = await app.request('/v1/channels', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '迁移前重名渠道' }),
      });
      expect(duplicate.status).toBe(201);
    }
    await expect(migrateSchema(db.pool, MIGRATIONS_FOLDER, db.schema)).rejects.toThrow(
      /channels_user_name_uidx|could not create unique index|duplicate key/i,
    );
  } finally {
    await dropTestSchema(db);
    await rm(prior, { recursive: true, force: true });
  }
});
