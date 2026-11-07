# bafang-core

八方来财 · 后端：行情聚合、用户与登录方式、Agent、MCP。bafang-core 是 studio 与 glance 的唯一数据源（见 `docs/adr/0002`），通过 HTTP API（附 OpenAPI 文档）对外服务。

技术栈：Node.js + TypeScript，Hono，PostgreSQL + Drizzle（ORM 与迁移），zod（请求/响应 schema，并由同一份 schema 生成 OpenAPI），Vitest。

## 本地开发

前置：Node.js 20+、pnpm、PostgreSQL 16（本地开发库 `test_bafang`，角色无 `CREATEDB` 权限）。没有本地 PostgreSQL 的话可以用 `docker compose` 起一个（见下文）。

1. 安装依赖：

   ```bash
   pnpm install
   ```

2. 配置环境变量。复制示例文件并填入真实值（真实 `.env` 已被 gitignore，不要提交）：

   ```bash
   cp .env.example .env
   ```

   数据库连接使用分开的 `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` 字段（密码可能含逗号，不要拼成 URL），可选用 `PGSCHEMA` 指定 schema（默认 `public`，迁移与按年导入都会遵循它）。

3. 执行迁移（在空库上建出初始结构，重复执行幂等）：

   ```bash
   pnpm db:migrate
   ```

4. 启动服务：

   ```bash
   pnpm dev
   ```

## 用 Docker Compose 起开发数据库

本机没有 PostgreSQL 时，用 `compose.yaml` 起一个开发库（角色 `test_bafang`，无 `CREATEDB` 权限，与 `.env.example` 一致）：

```bash
docker compose up -d
```

首次启动会自动执行 `docker/initdb` 里的初始化脚本，创建 `test_bafang` 角色与数据库。之后按上面的步骤 `cp .env.example .env`、`pnpm db:migrate` 即可，`.env` 的用法不变。

## 接口

- `GET /v1/health` — 健康检查，返回存活状态与数据库连通性。
- `GET /v1/openapi` — 由请求/响应 schema 自动生成的 OpenAPI 文档（JSON）。
- `GET /v1/funds/search?q=` — 基金搜索，按基金代码、名称或拼音首字母匹配，只返回基金（过滤上游混入的股票、指数）。
- `GET /v1/funds/{code}` — 基金基础信息：名称、代码、类别（`domestic` 境内 / `qdii` / `etf_feeder` ETF 联接，QDII 的 ETF 联接归为 `qdii`）与 T+N 确认规则；上游取不到 T+N 时按类别默认（境内与 ETF 联接 T+1，QDII T+2），并以 `settlement.source` 标明来源。
- `GET /v1/funds/{code}/nav` — 基金最新净值：单位净值、累计净值、净值日期与当日涨跌幅（净值保留 4 位小数，用字符串表示以规避二进制浮点误差）。
- `GET /v1/funds/{code}/nav/history?range=1m|3m|1y` — 基金历史净值走势，按区间（近 1 月 / 3 月 / 1 年）返回净值序列（最新在前）。
- `GET /v1/market/status` — 市场状态：`trading` 交易中、`closed` 已收盘、`holiday` 休市、`pre_market` 盘前。四种状态都是显式枚举，不以 0 表示。

### GitHub 网页登录

- 配置 `.env.example` 中的 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`GITHUB_CALLBACK_URL`、`GITHUB_LOGIN_REDIRECT_URL`；四项都非空才启用，缺失时服务仍可启动，两个接口返回 503 `github_not_configured`。回调 URL 必须与 GitHub OAuth App 登记的地址一致；成功后的网页地址仅来自配置，请求参数不能覆盖。两个地址使用 HTTP(S) 绝对 URL，生产环境用 HTTPS。
- 浏览器访问 `GET /v1/auth/github`，获取 302 到 GitHub 授权页；采用授权码流程、S256 PKCE 和随机 state。临时 `__Host-bafang_github` Cookie 为 httpOnly、Secure、SameSite=Lax，绑定发起浏览器。Cookie 始终为 Secure，本地联调需要 HTTPS 或受信 localhost。
- GitHub 回调 `GET /v1/auth/github/callback?code=...&state=...`。state 和浏览器标识只存哈希，10 分钟后过期；PostgreSQL 原子删除消费，跨应用实例也只能用一次。过期请求在下次发起时清理。state 缺失、不匹配、过期、重放返回 400 `github_state_invalid`，拒绝授权/缺少 code 返回 400 `github_authorization_failed`；有效回调开始后即消费 state，失败需重新发起。
- 每次登录都经 `GitHubOAuth` 适配器交换 code 并调用 GitHub `/user`，以数字 `id` 识别用户；不按 `login` 或邮箱识别。真实实现使用固定 HTTPS 端点、每次请求 5 秒超时、不自动重试。上游出错或格式无效返回 502 `github_unavailable`，不创建用户、登录方式或会话。GitHub token 不保存、不返回给网页。
- 首次登录复用邮箱登录的建用户路径，预置支付宝、天天基金、未指定三个渠道。成功后设置同样的 `bafang_session` 会话 Cookie（httpOnly、Secure、SameSite=Lax，30 天），302 到固定网页地址，可使用 `/v1/me`、`/v1/auth/logout`。发起与回调分别按客户端 IP 每分钟限流 10 次（沿用进程内限流）。两个接口均带 `Cache-Control: no-store` 和 `Referrer-Policy: no-referrer`。
- 测试通过 `createApp({ github: { oauth, redirectUrl } })` 注入假 GitHub 适配器；真实协议的响应验证也用假 HTTP 出口，不访问真实 GitHub。新表由 `0004` 迁移创建，部署需先执行 `pnpm db:migrate`。

### 微信小程序登录

- 配置 `.env.example` 中的 `WECHAT_APP_ID` 与 `WECHAT_APP_SECRET`；两项都非空才启用，缺失或空白时服务照常启动，登录接口返回 503 `wechat_not_configured`。AppSecret 只留在服务端。
- glance 调用 `wx.login`，将得到的 code 作为 JSON `{ "code": "..." }` 提交到 `POST /v1/auth/wechat/login`。成功返回 `{ user: { id }, session: { device: "miniprogram", expiresAt }, token }`，不设置 Cookie。后续请求（如 `/v1/me` 与 `/v1/auth/logout`）使用 `Authorization: Bearer <token>`。会话有效期 30 天，每次登录建立独立会话，退出只作废当前会话。
- 通过可注入的 `WeChatCode2Session` 适配器调用固定 HTTPS `code2session` 端点，使用 openid 作为 `wechat` 登录方式的外部标识，不依赖或存储 unionid。首次登录复用共用事务路径创建用户、三个预置渠道（支付宝、天天基金、未指定）与会话；同一 openid 再次登录返回同一用户。
- 真实适配器每次请求 5 秒超时、禁止重定向、不自动重试一次性 code。微信返回 40029（无效）或 40163（已使用）时返回 400 `wechat_code_invalid`；微信限频、系统繁忙、登录拦截、其他上游错误、网络失败、超时或响应格式异常返回 502 `wechat_unavailable`，失败不写用户、登录方式或会话。重试登录前应重新调用 `wx.login` 获取 code。
- session_key 不返回、不持久化、不写日志。接口响应带 `Cache-Control: no-store`，复用进程内 IP 限流，每分钟 10 次，超出返回 429 `rate_limited` 与 `Retry-After`。
- 测试通过 `createApp({ wechat })` 注入假适配器，真实协议使用假 HTTP 出口验证，不访问真实微信。复用已有表结构，无需新增迁移。

### 行情接口

- **匿名只读 + 限流：** `/v1/funds/*` 不需要登录，按客户端 IP 每分钟 60 次（固定窗口，进程内），超出返回 429 `rate_limited` 与 `Retry-After`。客户端 IP 取 `X-Forwarded-For` 的最右一项（部署时 core 位于 Caddy 之后，由 Caddy 追加），没有该请求头时取连接对端地址；因此 core 不应绕过 Caddy 直接暴露在公网上。
- **缓存：** 搜索结果按 Asia/Shanghai 日期在进程内缓存一天（空结果也缓存，上游失败不缓存），到上海时间零点失效。净值缓存到当天净值公布窗口（以 19:00 Asia/Shanghai 为界，公布前的请求沿用上一个公布日的缓存，公布窗口一到即重新抓取）。
- **统一上游抓取适配器：** 所有上游请求都经过 `src/market/upstream.ts` 的 `UpstreamFetcher`。默认实现 `HttpUpstreamFetcher` 负责浏览器请求头与各上游的 Referer、超时（5 秒）、重试（超时、网络错误、5xx、429、空响应体最多再试 2 次，其他 4xx 不重试）和编码（请求指定或按 `Content-Type` 的 charset 解码，支持 GBK）。上游失败统一返回 502 `upstream_unavailable`，诊断详情只写服务端日志。上游地址属于行情模块内部细节。
- **测试：** 适配器通过 `createApp({ upstream })` 整体替换为 `test/support/recorded-upstream.ts` 的录制样本回放（样本说明见 `test/fixtures/upstream/README.md`）。

公开接口按父 spec 的 API 约定使用版本前缀（`/v1/...`）。健康检查接口没有版本豁免，因此挂在 `/v1/health`；OpenAPI 文档也统一放在 `/v1/openapi`，让 studio / glance 与监控只面对 `/v1` 一个版本化入口，无需额外记忆未版本化的路径。旧路径 `/health` 与 `/openapi` 不再注册，会返回统一的 404。

## 测试

```bash
pnpm test        # 全部测试（连接真实 PostgreSQL）
pnpm test:watch  # watch 模式
```

测试唯一的入口是在进程内对 core 应用发 HTTP 请求（`app.request(...)`），并连接真实的 PostgreSQL 测试库。因为角色没有 `CREATEDB` 权限，测试隔离用「每个用例一个临时 schema」：建好后在 schema 内跑迁移，用完删除，互不干扰。迁移只作为准备测试环境的步骤，用例不直接断言表结构、迁移记录、内部函数或调用次数；时钟与交易日历替身通过应用的依赖注入在 HTTP 用例中生效。

## 迁移与 schema

- 修改 `src/db/schema.ts` 后用 `pnpm db:generate` 生成迁移 SQL（输出到 `drizzle/`）。
- 用 `pnpm db:migrate` 应用迁移；目标 schema 由 `PGSCHEMA` 决定，未设置时默认 `public`。应用启动与 `pnpm trading-calendar:import` 使用同一份 schema 配置，避免迁移建表在 `public`、而应用去别的 schema 找表。
- 迁移运行器支持把迁移应用到任意 schema（测试里用它创建临时 schema）。

## 依赖注入

时钟（`Clock`）、交易日历（`TradingCalendar`）与统一上游抓取适配器（`UpstreamFetcher`）是可注入的依赖，默认实现是 `SystemClock`、`ChineseTradingCalendar`（按 Asia/Shanghai 判断工作日，并排除已导入的休市日）与 `HttpUpstreamFetcher`。测试可注入替身，例如固定时钟。

## 交易日历

A 股交易日历由 core 自己维护：休市日按年导入到 `trading_holidays` 表，`ChineseTradingCalendar` 在判断交易日时排除这些日期（周末恒为休市，不需要导入）。仓库内置了 `data/holidays/2026.json`（2026 年工作日休市日，来源为上海证券交易所的年度休市安排）。

- 导入某一年（默认读取 `data/holidays/<年份>.json`，重复执行幂等）：

  ```bash
  pnpm trading-calendar:import 2026
  ```

- 导入自定义文件：

  ```bash
  pnpm trading-calendar:import 2026 --file /path/to/holidays.json
  ```

- 启动服务时 `src/index.ts` 会从 `trading_holidays` 表加载已导入的休市日，注入给 `ChineseTradingCalendar`，供市场状态等接口使用。

## 错误结构

所有错误统一返回 `{ error: { code, message } }`，其中 `code` 是机器可读的错误码、`message` 是人类可读的说明；该结构出现在 OpenAPI 文档的 `Error` schema 中，`code` 的取值（`database_unavailable`、`not_found`、`internal_error`、`validation_error`、`fund_not_found`、`upstream_unavailable`、`rate_limited`）以枚举形式列出。未捕获的异常由全局处理返回统一的 `internal_error`，诊断详情只留在服务端日志。

## 常用脚本

| 命令                                | 说明                       |
| ----------------------------------- | -------------------------- |
| `pnpm dev` / `pnpm start`           | 启动服务（watch / 单次）   |
| `pnpm typecheck`                    | 类型检查（`tsc --noEmit`） |
| `pnpm lint`                         | ESLint                     |
| `pnpm format:check`                 | 格式检查（Prettier）       |
| `pnpm db:generate`                  | 生成迁移 SQL               |
| `pnpm db:migrate`                   | 应用迁移                   |
| `pnpm trading-calendar:import 2026` | 按年导入休市日             |
| `pnpm test`                         | 全部测试                   |
| `docker compose up -d`              | 起本地开发数据库           |
