import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createDb, migrateSchema, MIGRATIONS_FOLDER } from '../../src/db';
import { migrationFolderThrough } from '../support/migrations';
import { createTestSchema, dropTestSchema } from '../support/test-db';

// D17: migration-only setup may select the old migration chain; behavior is checked over HTTP.
describe('binding-code migration over HTTP', () => {
  it.each(['fresh', 'upgrade'] as const)(
    'supports the complete binding flow after %s migration',
    async (mode) => {
      const folder = await migrationFolderThrough(9);
      let database: Awaited<ReturnType<typeof createTestSchema>> | undefined;
      try {
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
