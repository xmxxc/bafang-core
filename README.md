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
- `GET /v1/market/indices` — 大盘指数：上证指数、深证成指、创业板指、恒生指数的点位、昨收、涨跌额、涨跌幅，以及各自市场的状态（每次请求按所属市场的交易日历重新判定：A 股日历；港股日历含休市日与半日市，港股 09:30 开市、16:10 收市，半日市按日历给出的时刻收市）。腾讯为主来源，单个指数取不到或不可信（字段缺失，或交易日与日历给出的应有交易日对不上：已开盘的交易日必须是当天的报价，盘前与休市不得早于上一个交易日）时回退到同花顺；同花顺同时取快照与分时交叉校验，昨收不一致或最新价相差超过昨收的 0.5% 即视为陈旧数据。都失败时该指数 `available: false`、数值为 `null`、`source: null`，整体仍返回 200；`fallback` 标明是否发生了回退。非交易时段返回最近一个交易日的收盘数据。

### 行情接口

- **匿名只读 + 限流：** `/v1/funds/*` 与 `/v1/market/*` 不需要登录，按客户端 IP 每分钟 60 次（固定窗口，进程内），超出返回 429 `rate_limited` 与 `Retry-After`。客户端 IP 取 `X-Forwarded-For` 的最右一项（部署时 core 位于 Caddy 之后，由 Caddy 追加），没有该请求头时取连接对端地址；因此 core 不应绕过 Caddy 直接暴露在公网上。
- **缓存：** 搜索结果按 Asia/Shanghai 日期在进程内缓存一天（空结果也缓存，上游失败不缓存），到上海时间零点失效。净值缓存到当天净值公布窗口（以 19:00 Asia/Shanghai 为界，公布前的请求沿用上一个公布日的缓存，公布窗口一到即重新抓取）。大盘指数按指数分别缓存行情（状态不缓存）：所属市场交易中 10 秒、盘前 30 秒、已收盘与休市 5 分钟，不可用的结果只缓存 10 秒，并且一律截断到所属市场的下一个时段边界（开盘、午休、收盘、半日市收市、零点）。
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

A 股与港股的交易日历都由 core 自己维护：特殊日期按市场、按年导入到 `trading_holidays` 表（`market` 为 `cn` 或 `hk`；`early_close` 为空是全天休市，有值是半日市的收市时刻）。`ChineseTradingCalendar` 与 `HongKongTradingCalendar` 在判断交易日时排除休市日（周末恒为休市，不需要导入），港股日历还给出半日市的收市时刻。仓库内置了 `data/holidays/2026.json`（A 股，来源为上海证券交易所的年度休市安排）与 `data/holidays/hk-2026.json`（港股，来源为香港特区政府 2026 年公众假期及港交所的半日市安排）。

- 导入某一年（默认读取 `data/holidays/<年份>.json`，重复执行幂等）：

  ```bash
  pnpm trading-calendar:import 2026
  ```

- 导入港股（默认读取 `data/holidays/hk-<年份>.json`；与 A 股的数据互不影响）：

  ```bash
  pnpm trading-calendar:import 2026 --market hk
  ```

- 导入自定义文件：

  ```bash
  pnpm trading-calendar:import 2026 --file /path/to/holidays.json
  ```

- 启动服务时 `src/index.ts` 会从 `trading_holidays` 表分别加载两个市场的数据，注入给 `ChineseTradingCalendar` 与 `HongKongTradingCalendar`，供市场状态、大盘指数等接口使用。没有导入港股某年的数据时，港股只按周末判断；遇到港股假日，指数会因为缺当日行情显示为不可用，而不会给出错误的状态。

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
