/**
 * 生成 OpenAPI 文档并写到仓库根目录的 openapi.json（studio 与 glance 的接口契约，ADR 0002）。
 *
 * - `pnpm openapi:generate`：重新生成并覆盖 openapi.json；
 * - `pnpm openapi:check`：生成后与已提交的 openapi.json 比对，不一致则以非零状态退出（CI 用来防止契约漂移）。
 *
 * 文档只由路由的请求/响应 schema 决定，不连接数据库、不访问上游，结果稳定可比对。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app';

const OUTPUT = fileURLToPath(new URL('../openapi.json', import.meta.url));

async function render(): Promise<string> {
  const res = await createApp().request('/v1/openapi');
  if (!res.ok) throw new Error(`GET /v1/openapi 返回 ${res.status}`);
  return `${JSON.stringify(await res.json(), null, 2)}\n`;
}

const generated = await render();

if (process.argv.includes('--check')) {
  const committed = await readFile(OUTPUT, 'utf8').catch(() => '');
  if (committed !== generated) {
    console.error(
      'openapi.json 与当前代码生成的文档不一致；请运行 pnpm openapi:generate 并提交结果。',
    );
    process.exit(1);
  }
  console.log('openapi.json 与生成结果一致。');
} else {
  await writeFile(OUTPUT, generated);
  console.log(`已写入 ${OUTPUT}`);
}
