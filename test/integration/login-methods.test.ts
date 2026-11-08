import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import { createDb, migrateSchema, MIGRATIONS_FOLDER } from '../../src/db';
import type { GitHubOAuth } from '../../src/auth/github';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';

describe('login method management over HTTP', () => {
  let db: TestSchema;
  let code = '';
  let githubId = 'github-a';
  const clock = { now: () => new Date('2026-11-06T02:00:00Z') };
  const mailer = {
    async sendVerificationCode(_email: string, value: string) {
      code = value;
    },
  };
  const oauth: GitHubOAuth = {
    authorizationUrl: (state) => `https://github.test/?state=${state}`,
    userId: async () => githubId,
  };
  beforeEach(async () => {
    db = await createTestSchema();
    code = '';
    githubId = 'github-a';
  });
  afterEach(async () => {
    await dropTestSchema(db);
  });
  const app = (extra: AppDeps = {}) =>
    createApp({
      database: createDb(db.pool),
      mailer,
      clock,
      github: { oauth, redirectUrl: 'https://studio.test/' },
      ...extra,
    });
  async function emailLogin(target: ReturnType<typeof app>, email: string) {
    await target.request('/v1/auth/email/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const response = await target.request('/v1/auth/email/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, device: 'web' }),
    });
    return response.headers
      .getSetCookie()
      .find((item) => item.startsWith('bafang_session='))!
      .split(';')[0]!;
  }
  async function githubLogin(target: ReturnType<typeof app>, id: string) {
    githubId = id;
    const start = await target.request('/v1/auth/github');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const browser = start.headers.get('set-cookie')!.split(';')[0]!;
    const callback = await target.request(`/v1/auth/github/callback?state=${state}&code=ok`, {
      headers: { Cookie: browser },
    });
    return callback.headers
      .getSetCookie()
      .find((item) => item.startsWith('bafang_session='))!
      .split(';')[0]!;
  }
  async function linkGithub(target: ReturnType<typeof app>, cookie: string, id: string) {
    githubId = id;
    const start = await target.request('/v1/auth/github?intent=link', {
      headers: { Cookie: cookie },
    });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const browser = start.headers.get('set-cookie')!.split(';')[0]!;
    return target.request(`/v1/auth/github/callback?state=${state}&code=ok`, {
      headers: { Cookie: `${cookie}; ${browser}` },
    });
  }
  async function linkEmail(target: ReturnType<typeof app>, cookie: string, email: string) {
    await target.request('/v1/auth/email/link/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email }),
    });
    return target.request('/v1/auth/email/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email, code }),
    });
  }

  async function migrationFolderThrough(maxIdx: number) {
    const folder = await mkdtemp(join(tmpdir(), `login-methods-migrations-${maxIdx}-`));
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
      if (
        name.endsWith('.json') &&
        name !== '_journal.json' &&
        Number(name.slice(0, 4)) <= maxIdx
      ) {
        await copyFile(join(sourceMeta, name), join(folder, 'meta', name));
      }
    }
    return folder;
  }

  it('lists safe display information and associates GitHub and email', async () => {
    const target = app();
    const cookie = await githubLogin(target, 'github-list');
    expect((await linkEmail(target, cookie, 'safe@example.com')).status).toBe(200);
    const list = await target.request('/v1/me/login-methods', { headers: { Cookie: cookie } });
    expect(await list.json()).toEqual({
      items: [
        { type: 'github', display: 'GitHub 用户 github-list' },
        { type: 'email', display: 'safe@example.com' },
      ],
    });
  });

  it('rejects unauthenticated linking, transfers empty users, and rejects held-user conflicts', async () => {
    const target = app();
    expect((await target.request('/v1/auth/github?intent=link')).status).toBe(401);
    const other = await githubLogin(target, 'github-transfer');
    const current = await emailLogin(target, 'current@example.com');
    expect((await linkGithub(target, current, 'github-transfer')).status).toBe(302);
    expect((await target.request('/v1/me', { headers: { Cookie: other } })).status).toBe(401);
    const heldTarget = app({ hasUserPositions: async () => true });
    await githubLogin(heldTarget, 'github-held');
    const heldCurrent = await emailLogin(heldTarget, 'held@example.com');
    expect((await linkGithub(heldTarget, heldCurrent, 'github-held')).status).toBe(409);
  });

  it('enforces one type per user and serializes concurrent final unlinks', async () => {
    const target = app();
    const cookie = await githubLogin(target, 'github-one');
    expect((await linkGithub(target, cookie, 'github-two')).status).toBe(409);
    expect((await linkEmail(target, cookie, 'unlink@example.com')).status).toBe(200);
    const statuses = await Promise.all(
      ['email', 'github'].map((type) =>
        Promise.resolve(
          target.request(`/v1/me/login-methods/${type}`, {
            method: 'DELETE',
            headers: { Cookie: cookie },
          }),
        ).then((response) => response.status),
      ),
    );
    expect(statuses.sort()).toEqual([204, 409]);
  });

  it('upgrades 0000-0006 before using the 0007 GitHub association columns over HTTP', async () => {
    const prior = await migrationFolderThrough(6);
    const oldDb = await createTestSchema(prior);
    try {
      const target = createApp({
        database: createDb(oldDb.pool),
        mailer,
        clock,
        github: { oauth, redirectUrl: 'https://studio.test/' },
      });
      const email = 'incremental-upgrade@example.com';
      await target.request('/v1/auth/email/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const login = await target.request('/v1/auth/email/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, device: 'web' }),
      });
      const cookie = login.headers
        .getSetCookie()
        .find((item) => item.startsWith('bafang_session='))!
        .split(';')[0]!;

      await migrateSchema(oldDb.pool, MIGRATIONS_FOLDER, oldDb.schema);
      githubId = 'github-incremental';
      const start = await target.request('/v1/auth/github?intent=link', {
        headers: { Cookie: cookie },
      });
      expect(start.status).toBe(302);
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const browser = start.headers.get('set-cookie')!.split(';')[0]!;
      const callback = await target.request(`/v1/auth/github/callback?state=${state}&code=ok`, {
        headers: { Cookie: `${cookie}; ${browser}` },
      });
      expect(callback.status).toBe(302);
      const listed = await target.request('/v1/me/login-methods', { headers: { Cookie: cookie } });
      expect(await listed.json()).toEqual({
        items: [
          { type: 'email', display: email },
          { type: 'github', display: 'GitHub 用户 github-incremental' },
        ],
      });
    } finally {
      await dropTestSchema(oldDb);
      await rm(prior, { recursive: true, force: true });
    }
  });
});
