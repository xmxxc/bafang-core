import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createDb, migrateSchema, MIGRATIONS_FOLDER } from '../../src/db';
import { createTestSchema, dropTestSchema } from '../support/test-db';

// D17: migration-only setup may select the old migration chain; behavior is checked over HTTP.
describe('binding-code migration over HTTP', () => {
  it.each(['fresh', 'upgrade'] as const)(
    'supports the complete binding flow after %s migration',
    async (mode) => {
      const folder = await mkdtemp(join(tmpdir(), 'binding-migrations-'));
      let database: Awaited<ReturnType<typeof createTestSchema>> | undefined;
      try {
        await mkdir(join(folder, 'meta'));
        const journal = JSON.parse(
          await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
        ) as {
          entries: { idx: number; tag: string }[];
        };
        journal.entries = journal.entries.filter((entry) => entry.idx <= 9);
        await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
        for (const entry of journal.entries) {
          await copyFile(
            join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
            join(folder, `${entry.tag}.sql`),
          );
        }
        database = await createTestSchema(mode === 'upgrade' ? folder : MIGRATIONS_FOLDER);
        let emailCode = '';
        const app = createApp({
          database: createDb(database.pool),
          bindCodeSecret: 'migration-test-secret',
          mailer: {
            async sendVerificationCode(_email, value) {
              emailCode = value;
            },
          },
          wechat: {
            async openid(code) {
              return `migration-${code}`;
            },
          },
        });
        await app.request('/v1/auth/email/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'migration@example.com' }),
        });
        const login = await app.request('/v1/auth/email/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'migration@example.com', code: emailCode, device: 'web' }),
        });
        expect(login.status).toBe(200);
        const cookie = login.headers
          .getSetCookie()
          .find((value) => value.startsWith('bafang_session='))!
          .split(';')[0]!;
        const user = ((await login.json()) as { user: { id: string } }).user;
        if (mode === 'upgrade')
          await migrateSchema(database.pool, MIGRATIONS_FOLDER, database.schema);
        const generated = await app.request('/v1/auth/bind-code', {
          method: 'POST',
          headers: { Cookie: cookie },
        });
        expect(generated.status).toBe(201);
        const { code } = (await generated.json()) as { code: string };
        const bound = await app.request('/v1/auth/wechat/bind', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'upgrade-owner', bindCode: code }),
        });
        expect(bound.status).toBe(200);
        const session = (await bound.json()) as { user: { id: string }; token: string };
        expect(session.user).toEqual(user);
        expect(
          (await app.request('/v1/me', { headers: { Authorization: `Bearer ${session.token}` } }))
            .status,
        ).toBe(200);
        const replay = await app.request('/v1/auth/wechat/bind', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'upgrade-owner', bindCode: code }),
        });
        expect(replay.status).toBe(400);
        expect(await replay.json()).toMatchObject({ error: { code: 'bind_code_used' } });
      } finally {
        if (database) await dropTestSchema(database);
        await rm(folder, { recursive: true, force: true });
      }
    },
  );
});
