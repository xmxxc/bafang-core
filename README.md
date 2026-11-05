# bafang-core

八方来财 · 后端：行情聚合、账号与同步、Agent、MCP。bafang-core 是 studio 与 glance 的唯一数据源（见 `docs/adr/0002`），通过 HTTP API（附 OpenAPI 文档）对外服务。

技术栈：Node.js + TypeScript，Hono，PostgreSQL + Drizzle（ORM 与迁移），zod（请求/响应 schema，并由同一份 schema 生成 OpenAPI），Vitest。

## 本地开发

前置：Node.js 20+、pnpm、PostgreSQL 16（本地开发库 `test_bafang`，角色无 `CREATEDB` 权限）。

1. 安装依赖：

   ```bash
   pnpm install
   ```

2. 配置环境变量。复制示例文件并填入真实值（真实 `.env` 已被 gitignore，不要提交）：

   ```bash
   cp .env.example .env
   ```

   数据库连接使用分开的 `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` 字段（密码可能含逗号，不要拼成 URL）。

3. 执行迁移（在空库上建出初始结构，重复执行幂等）：

   ```bash
   pnpm db:migrate
   ```

4. 启动服务：

   ```bash
   pnpm dev
   ```

## 接口

- `GET /health` — 健康检查，返回存活状态与数据库连通性。
- `GET /openapi` — 由请求/响应 schema 自动生成的 OpenAPI 文档（JSON）。

## 测试

```bash
pnpm test          # 全部测试
pnpm test:fast     # 单元测试（不需要数据库）
pnpm test:focused  # 集成测试（连接真实 PostgreSQL）
```

测试唯一的入口是在进程内对 core 应用发 HTTP 请求（`app.request(...)`），并连接真实的 PostgreSQL 测试库。因为角色没有 `CREATEDB` 权限，测试隔离用「每个用例一个临时 schema」：建好后在 schema 内跑迁移，用完删除，互不干扰。

## 迁移与 schema

- 修改 `src/db/schema.ts` 后用 `pnpm db:generate` 生成迁移 SQL（输出到 `drizzle/`）。
- 用 `pnpm db:migrate` 应用迁移到默认 schema（`public`）。
- 迁移运行器支持把迁移应用到任意 schema（测试里用它创建临时 schema）。

## 依赖注入

时钟（`Clock`）与交易日历（`TradingCalendar`）是可注入的依赖，默认实现是 `SystemClock` 与 `ChineseTradingCalendar`（按 Asia/Shanghai 判断交易日；节假日导入在后续票据补齐）。测试可注入替身，例如固定时钟。

## 错误结构

所有错误统一返回 `{ error: { code, message } }`，其中 `code` 是机器可读的错误码、`message` 是人类可读的说明；该结构出现在 OpenAPI 文档的 `Error` schema 中。

## 常用脚本

| 命令                      | 说明                       |
| ------------------------- | -------------------------- |
| `pnpm dev` / `pnpm start` | 启动服务（watch / 单次）   |
| `pnpm typecheck`          | 类型检查（`tsc --noEmit`） |
| `pnpm lint`               | ESLint                     |
| `pnpm format:check`       | 格式检查（Prettier）       |
| `pnpm db:generate`        | 生成迁移 SQL               |
| `pnpm db:migrate`         | 应用迁移                   |
| `pnpm test`               | 全部测试                   |
