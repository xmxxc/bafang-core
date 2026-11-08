import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import { createDb, migrateSchema, MIGRATIONS_FOLDER } from '../../src/db';
import type { GitHubOAuth } from '../../src/auth/github';
import { createTestSchema, dropTestSchema, type TestSchema } from '../support/test-db';
import { eastmoneySamples, RecordedUpstream } from '../support/recorded-upstream';

describe('login method management over HTTP', () => {
  let db: TestSchema;
  let code = '';
  let githubId = 'github-a';
  let offsetMs = 0;
  const clock = { now: () => new Date(Date.parse('2026-11-06T02:00:00Z') + offsetMs) };
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
    offsetMs = 0;
  });
  afterEach(async () => {
    await dropTestSchema(db);
  });
  const app = (extra: AppDeps = {}) =>
    createApp({
      database: createDb(db.pool),
      mailer,
      clock,
      upstream: new RecordedUpstream(eastmoneySamples),
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

  const json = { 'Content-Type': 'application/json' };
  async function startLink(target: ReturnType<typeof app>, cookie: string) {
    const start = await target.request('/v1/auth/github?intent=link', {
      headers: { Cookie: cookie },
    });
    expect(start.status).toBe(302);
    return {
      state: new URL(start.headers.get('location')!).searchParams.get('state')!,
      browser: start.headers.get('set-cookie')!.split(';')[0]!,
    };
  }
  async function me(target: ReturnType<typeof app>, cookie: string) {
    const response = await target.request('/v1/me', { headers: { Cookie: cookie } });
    return response.status === 200
      ? ((await response.json()) as { user: { id: string } }).user.id
      : response.status;
  }
  async function errorCode(response: Response) {
    return ((await response.json()) as { error: { code: string } }).error.code;
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

  it('rejects linking when the other user holds a real position, even a cleared one', async () => {
    const target = app();
    const holder = await githubLogin(target, 'github-holder');
    const channels = (await (
      await target.request('/v1/channels', { headers: { Cookie: holder } })
    ).json()) as { items: { id: string }[] };
    const created = await target.request('/v1/positions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: holder },
      body: JSON.stringify({
        fundCode: '110020',
        channelId: channels.items[0]!.id,
        shares: '1',
        totalCost: '1',
      }),
    });
    expect(created.status).toBe(201);
    const positionId = ((await created.json()) as { id: string }).id;
    const current = await emailLogin(target, 'wants-holder@example.com');
    const rejected = await linkGithub(target, current, 'github-holder');
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: 'login_method_conflict' } });

    // 已清仓的持仓也算有数据。
    const cleared = await target.request(`/v1/positions/${positionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: holder },
      body: JSON.stringify({ shares: '0', totalCost: '0' }),
    });
    expect(cleared.status).toBe(200);
    const stillRejected = await linkGithub(target, current, 'github-holder');
    expect(stillRejected.status).toBe(409);
    expect(await stillRejected.json()).toMatchObject({ error: { code: 'login_method_conflict' } });
    expect((await target.request('/v1/me', { headers: { Cookie: holder } })).status).toBe(200);
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

  it('binds GitHub link state to the initiating session', async () => {
    const target = app();
    const s1 = await emailLogin(target, 'bound@example.com');
    offsetMs += 61_000;
    const s2 = await emailLogin(target, 'bound@example.com');
    const userId = await me(target, s1);
    expect(await me(target, s2)).toBe(userId);
    githubId = 'github-bound';

    // 发起会话仍有效，但回调换成同一用户的另一会话：拒绝。
    const swapped = await startLink(target, s1);
    const swappedCallback = await target.request(
      `/v1/auth/github/callback?state=${swapped.state}&code=ok`,
      { headers: { Cookie: `${s2}; ${swapped.browser}` } },
    );
    expect(swappedCallback.status).toBe(401);
    expect(await errorCode(swappedCallback)).toBe('unauthorized');

    // S1 发起后退出：S1、S2 回调都被拒。
    const first = await startLink(target, s1);
    const second = await startLink(target, s1);
    expect(
      (await target.request('/v1/auth/logout', { method: 'POST', headers: { Cookie: s1 } })).status,
    ).toBe(204);
    for (const [link, cookie] of [
      [first, s1],
      [second, s2],
    ] as const) {
      const callback = await target.request(
        `/v1/auth/github/callback?state=${link.state}&code=ok`,
        { headers: { Cookie: `${cookie}; ${link.browser}` } },
      );
      expect(callback.status).toBe(401);
      expect(await errorCode(callback)).toBe('unauthorized');
    }
    const before = await target.request('/v1/me/login-methods', { headers: { Cookie: s2 } });
    expect(await before.json()).toEqual({
      items: [{ type: 'email', display: 'bound@example.com' }],
    });

    // 正常路径：同一会话发起并回调。
    const ok = await startLink(target, s2);
    const okCallback = await target.request(`/v1/auth/github/callback?state=${ok.state}&code=ok`, {
      headers: { Cookie: `${s2}; ${ok.browser}` },
    });
    expect(okCallback.status).toBe(302);
    const after = await target.request('/v1/me/login-methods', { headers: { Cookie: s2 } });
    expect(await after.json()).toEqual({
      items: [
        { type: 'email', display: 'bound@example.com' },
        { type: 'github', display: 'GitHub 用户 github-bound' },
      ],
    });
  });

  it('serializes concurrent login and link of an identity held by an empty user', async () => {
    const target = app();
    for (let round = 0; round < 5; round += 1) {
      const identity = `github-race-${round}`;
      const emptyOwner = await githubLogin(target, identity);
      const emptyUserId = await me(target, emptyOwner);
      const current = await emailLogin(target, `race-${round}@example.com`);
      const currentUserId = await me(target, current);
      githubId = identity;
      const loginStart = await target.request('/v1/auth/github');
      const loginState = new URL(loginStart.headers.get('location')!).searchParams.get('state')!;
      const loginBrowser = loginStart.headers.get('set-cookie')!.split(';')[0]!;
      const link = await startLink(target, current);

      const [loginCallback, linkCallback] = await Promise.all([
        target.request(`/v1/auth/github/callback?state=${loginState}&code=ok`, {
          headers: { Cookie: loginBrowser },
        }),
        target.request(`/v1/auth/github/callback?state=${link.state}&code=ok`, {
          headers: { Cookie: `${current}; ${link.browser}` },
        }),
      ]);
      expect([loginCallback.status, linkCallback.status]).toEqual([302, 302]);
      const loginCookie = loginCallback.headers
        .getSetCookie()
        .find((item) => item.startsWith('bafang_session='))!
        .split(';')[0]!;

      // 关联总是成功：身份落到当前用户，空用户及其旧会话被删除。
      const listed = await target.request('/v1/me/login-methods', {
        headers: { Cookie: current },
      });
      expect(await listed.json()).toEqual({
        items: [
          { type: 'email', display: `race-${round}@example.com` },
          { type: 'github', display: `GitHub 用户 ${identity}` },
        ],
      });
      expect(await me(target, emptyOwner)).toBe(401);
      // 登录只有两种串行结果：关联在前则登录落在当前用户上且会话有效；
      // 登录在前则会话属于随后被转移删除的空用户，与先登录再关联的顺序执行结果相同。
      const loginUser = await me(target, loginCookie);
      expect([currentUserId, 401]).toContain(loginUser);
      expect(emptyUserId).not.toBe(currentUserId);
      // 之后再用该身份登录总是回到当前用户。
      expect(await me(target, await githubLogin(target, identity))).toBe(currentUserId);
      offsetMs += 61_000;
    }
  });

  it('lets a login that arrives during a transfer land on the receiving user', async () => {
    // 关联事务在持仓检查处停留，期间到达的同一身份登录必须等待并读取转移后的归属。
    let releaseCheck: () => void = () => {};
    let checking: () => void = () => {};
    const checkStarted = new Promise<void>((resolve) => (checking = resolve));
    const target = app({
      hasUserPositions: async () => {
        checking();
        await new Promise<void>((resolve) => (releaseCheck = resolve));
        return false;
      },
    });
    const identity = 'github-interleave';
    const emptyOwner = await githubLogin(target, identity);
    const current = await emailLogin(target, 'interleave@example.com');
    const currentUserId = await me(target, current);
    githubId = identity;
    const loginStart = await target.request('/v1/auth/github');
    const loginState = new URL(loginStart.headers.get('location')!).searchParams.get('state')!;
    const loginBrowser = loginStart.headers.get('set-cookie')!.split(';')[0]!;
    const link = await startLink(target, current);

    const linking = target.request(`/v1/auth/github/callback?state=${link.state}&code=ok`, {
      headers: { Cookie: `${current}; ${link.browser}` },
    });
    await checkStarted;
    const logging = target.request(`/v1/auth/github/callback?state=${loginState}&code=ok`, {
      headers: { Cookie: loginBrowser },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    releaseCheck();
    const [linkCallback, loginCallback] = await Promise.all([linking, logging]);
    expect([linkCallback.status, loginCallback.status]).toEqual([302, 302]);
    const loginCookie = loginCallback.headers
      .getSetCookie()
      .find((item) => item.startsWith('bafang_session='))!
      .split(';')[0]!;
    expect(await me(target, loginCookie)).toBe(currentUserId);
    expect(await me(target, emptyOwner)).toBe(401);
  });

  it('keeps login when another identity of the same empty user is linked away concurrently', async () => {
    const target = app();
    for (let round = 0; round < 5; round += 1) {
      const email = `sibling-${round}@example.com`;
      const sibling = `github-sibling-${round}`;
      const emptyOwner = await emailLogin(target, email);
      expect((await linkGithub(target, emptyOwner, sibling)).status).toBe(302);
      const current = await githubLogin(target, `github-current-${round}`);
      const currentUserId = await me(target, current);
      offsetMs += 61_000;
      const linkRequest = await target.request('/v1/auth/email/link/request', {
        method: 'POST',
        headers: { ...json, Cookie: current },
        body: JSON.stringify({ email }),
      });
      expect(linkRequest.status).toBe(200);
      const linkCode = code;
      githubId = sibling;
      const loginStart = await target.request('/v1/auth/github');
      const loginState = new URL(loginStart.headers.get('location')!).searchParams.get('state')!;
      const loginBrowser = loginStart.headers.get('set-cookie')!.split(';')[0]!;

      // 关联走邮箱（空用户随之删除，其 GitHub 身份级联消失），同时用该 GitHub 身份登录。
      const [linked, loginCallback] = await Promise.all([
        target.request('/v1/auth/email/link', {
          method: 'POST',
          headers: { ...json, Cookie: current },
          body: JSON.stringify({ email, code: linkCode }),
        }),
        target.request(`/v1/auth/github/callback?state=${loginState}&code=ok`, {
          headers: { Cookie: loginBrowser },
        }),
      ]);
      expect([linked.status, loginCallback.status]).toEqual([200, 302]);
      const loginCookie = loginCallback.headers
        .getSetCookie()
        .find((item) => item.startsWith('bafang_session='))!
        .split(';')[0]!;
      const loginUser = await me(target, loginCookie);
      // 登录在前：会话属于被删除的空用户；关联在前：该 GitHub 身份已不存在，登录新建用户且会话有效。
      if (loginUser !== 401) expect(loginUser).not.toBe(currentUserId);
      expect(await me(target, current)).toBe(currentUserId);
      offsetMs += 61_000;
    }
  });

  it('isolates login and link verification codes and rate-limits the link endpoint', async () => {
    const target = app();
    const current = await githubLogin(target, 'github-codes');
    const email = 'codes@example.com';

    await target.request('/v1/auth/email/request', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email }),
    });
    const loginCode = code;
    const loginForLink = await target.request('/v1/auth/email/link', {
      method: 'POST',
      headers: { ...json, Cookie: current },
      body: JSON.stringify({ email, code: loginCode }),
    });
    expect(loginForLink.status).toBe(400);
    expect(await errorCode(loginForLink)).toBe('verification_code_invalid');

    // 冷却按邮箱共享：推进时钟后再请求关联码。
    offsetMs += 61_000;
    const linkRequest = await target.request('/v1/auth/email/link/request', {
      method: 'POST',
      headers: { ...json, Cookie: current },
      body: JSON.stringify({ email }),
    });
    expect(linkRequest.status).toBe(200);
    const linkCode = code;
    const linkForLogin = await target.request('/v1/auth/email/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email, code: linkCode, device: 'web' }),
    });
    expect(linkForLogin.status).toBe(400);
    expect(await errorCode(linkForLogin)).toBe('verification_code_invalid');

    // 关联码与登录码互不作废，各自仍可用于本用途。
    const loginOk = await target.request('/v1/auth/email/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email, code: loginCode, device: 'web' }),
    });
    expect(loginOk.status).toBe(200);
    const emailUser = loginOk.headers
      .getSetCookie()
      .find((item) => item.startsWith('bafang_session='))!
      .split(';')[0]!;
    const linkOk = await target.request('/v1/auth/email/link', {
      method: 'POST',
      headers: { ...json, Cookie: current },
      body: JSON.stringify({ email, code: linkCode }),
    });
    expect(linkOk.status).toBe(200);
    expect(await me(target, emailUser)).toBe(401);

    // 防猜码：关联码错 5 次作废；同一 IP 每分钟 10 次后限流。
    const limited = app();
    const guesser = await githubLogin(limited, 'github-guesser');
    await limited.request('/v1/auth/email/link/request', {
      method: 'POST',
      headers: { ...json, Cookie: guesser },
      body: JSON.stringify({ email: 'guess@example.com' }),
    });
    const wrong = code === '000000' ? '111111' : '000000';
    const statuses: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const response = await limited.request('/v1/auth/email/link', {
        method: 'POST',
        headers: { ...json, Cookie: guesser },
        body: JSON.stringify({ email: 'guess@example.com', code: i < 5 ? wrong : code }),
      });
      statuses.push(`${response.status}:${await errorCode(response)}`);
    }
    expect(statuses).toEqual([
      ...Array(4).fill('400:verification_code_invalid'),
      ...Array(6).fill('400:verification_code_max_attempts'),
      '429:rate_limited',
    ]);
  });

  it('shares the per-email cooldown and daily limit between login and link codes', async () => {
    const target = app();
    const current = await githubLogin(target, 'github-cooldown');
    const requestLogin = (email: string) =>
      target.request('/v1/auth/email/request', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ email }),
      });
    const requestLink = (email: string) =>
      target.request('/v1/auth/email/link/request', {
        method: 'POST',
        headers: { ...json, Cookie: current },
        body: JSON.stringify({ email }),
      });

    // login → link 与 link → login：60 秒内第二次都被冷却拒绝。
    for (const [first, second, email] of [
      [requestLogin, requestLink, 'cooldown-a@example.com'],
      [requestLink, requestLogin, 'cooldown-b@example.com'],
    ] as const) {
      expect((await first(email)).status).toBe(200);
      offsetMs += 59_000;
      const blocked = await second(email);
      expect(blocked.status).toBe(429);
      expect(await errorCode(blocked)).toBe('email_code_cooldown');
      offsetMs += 2_000;
      expect((await second(email)).status).toBe(200);
    }

    // 每日上限按邮箱合计两种用途。
    const email = 'daily-shared@example.com';
    for (let i = 0; i < 10; i += 1) {
      offsetMs += 61_000;
      expect((await (i % 2 === 0 ? requestLogin : requestLink)(email)).status).toBe(200);
    }
    for (const request of [requestLogin, requestLink]) {
      offsetMs += 61_000;
      const over = await request(email);
      expect(over.status).toBe(429);
      expect(await errorCode(over)).toBe('email_code_daily_limit');
    }
  });

  it('creates a new user when an unlinked identity logs in again', async () => {
    const target = app();
    const cookie = await githubLogin(target, 'github-unlinked');
    const original = await me(target, cookie);
    expect((await linkEmail(target, cookie, 'keep@example.com')).status).toBe(200);
    expect(
      (
        await target.request('/v1/me/login-methods/github', {
          method: 'DELETE',
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(204);
    const again = await githubLogin(target, 'github-unlinked');
    const fresh = await me(target, again);
    expect(fresh).not.toBe(original);
    const listed = await target.request('/v1/me/login-methods', { headers: { Cookie: again } });
    expect(await listed.json()).toEqual({
      items: [{ type: 'github', display: 'GitHub 用户 github-unlinked' }],
    });
    expect(await me(target, cookie)).toBe(original);
  });

  it('upgrades 0000-0006 before using the 0007 GitHub association columns over HTTP', async () => {
    const prior = await migrationFolderThrough(6);
    const oldDb = await createTestSchema(prior);
    try {
      // 旧版 schema 上用微信登录建立会话（邮箱登录依赖 0007 新增的验证码用途列）。
      const target = createApp({
        database: createDb(oldDb.pool),
        mailer,
        clock,
        github: { oauth, redirectUrl: 'https://studio.test/' },
        wechat: { openid: async () => 'openid-incremental' },
      });
      const login = await target.request('/v1/auth/wechat/login', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ code: 'wx-code' }),
      });
      expect(login.status).toBe(200);
      const authorization = `Bearer ${((await login.json()) as { token: string }).token}`;

      await migrateSchema(oldDb.pool, MIGRATIONS_FOLDER, oldDb.schema);
      githubId = 'github-incremental';
      const start = await target.request('/v1/auth/github?intent=link', {
        headers: { Authorization: authorization },
      });
      expect(start.status).toBe(302);
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const browser = start.headers.get('set-cookie')!.split(';')[0]!;
      const callback = await target.request(`/v1/auth/github/callback?state=${state}&code=ok`, {
        headers: { Authorization: authorization, Cookie: browser },
      });
      expect(callback.status).toBe(302);
      // 升级后的验证码表：关联码与登录码按用途分开。
      const email = 'incremental-upgrade@example.com';
      const linkRequest = await target.request('/v1/auth/email/link/request', {
        method: 'POST',
        headers: { ...json, Authorization: authorization },
        body: JSON.stringify({ email }),
      });
      expect(linkRequest.status).toBe(200);
      const linked = await target.request('/v1/auth/email/link', {
        method: 'POST',
        headers: { ...json, Authorization: authorization },
        body: JSON.stringify({ email, code }),
      });
      expect(linked.status).toBe(200);
      const listed = await target.request('/v1/me/login-methods', {
        headers: { Authorization: authorization },
      });
      expect(await listed.json()).toEqual({
        items: [
          { type: 'wechat', display: '微信用户 openid-incremental' },
          { type: 'github', display: 'GitHub 用户 github-incremental' },
          { type: 'email', display: 'incremental-upgrade@example.com' },
        ],
      });
    } finally {
      await dropTestSchema(oldDb);
      await rm(prior, { recursive: true, force: true });
    }
  });
});
