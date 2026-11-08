import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// 双份全量测试并发时，CLI 用例实测最慢约 6.5 秒；取 2 倍余量并向上取整。
vi.setConfig({ testTimeout: 15_000 });

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 去掉与发信相关的环境变量，模拟"未配置发信方式"的干净启动环境。 */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.NODE_ENV;
  delete env.MAIL_TRANSPORT;
  delete env.RESEND_API_KEY;
  delete env.RESEND_FROM;
  return env;
}

function runStart(extra: Record<string, string> = {}): { status: number | null } {
  const result = spawnSync('pnpm', ['start'], {
    cwd: REPO_ROOT,
    env: { ...cleanEnv(), ...extra },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status };
}

describe('startup refuses to start when the mail transport is not explicitly configured', () => {
  it('exits non-zero when no mail transport and no NODE_ENV are configured', () => {
    expect(runStart().status).not.toBe(0);
  });

  it('exits non-zero when the Resend key and NODE_ENV are empty strings', () => {
    expect(runStart({ NODE_ENV: '', RESEND_API_KEY: '', RESEND_FROM: '' }).status).not.toBe(0);
  });
});
