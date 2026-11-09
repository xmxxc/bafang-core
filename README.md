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
- `GET /v1/openapi` — 由请求/响应 schema 自动生成的 OpenAPI 文档（JSON）。同一份文档提交在根目录 `openapi.json`，作为 studio 与 glance 的接口契约；改动接口后运行 `pnpm openapi:generate` 并一起提交，CI 会用 `pnpm openapi:check` 检查两者一致。
- `GET /v1/funds/search?q=` — 基金搜索，按基金代码、名称或拼音首字母匹配，只返回基金（过滤上游混入的股票、指数）。
- `GET /v1/funds/{code}` — 基金基础信息：名称、代码、类别（`domestic` 境内 / `qdii` / `etf_feeder` ETF 联接，QDII 的 ETF 联接归为 `qdii`）与 T+N 确认规则；上游取不到 T+N 时按类别默认（境内与 ETF 联接 T+1，QDII T+2），并以 `settlement.source` 标明来源。
- `GET /v1/funds/{code}/nav` — 基金最新净值：单位净值、累计净值、净值日期与当日涨跌幅（净值保留 4 位小数，用字符串表示以规避二进制浮点误差）。
- `GET /v1/funds/{code}/nav/history?range=1m|3m|1y` — 基金历史净值走势，按区间（近 1 月 / 3 月 / 1 年）返回净值序列（最新在前）。
- `GET /v1/market/status` — 市场状态：`trading` 交易中、`closed` 已收盘、`holiday` 休市、`pre_market` 盘前。四种状态都是显式枚举，不以 0 表示。
- `GET /v1/market/indices` — 大盘指数：上证指数、深证成指、创业板指、恒生指数的点位、昨收、涨跌额、涨跌幅，以及各自市场的状态（每次请求按所属市场的交易日历重新判定：A 股日历；港股日历含休市日与半日市，港股 09:30 开市、16:10 收市，半日市按日历给出的时刻收市）。腾讯为主来源，单个指数取不到或不可信（字段缺失，或交易日与日历给出的应有交易日对不上：已开盘的交易日必须是当天的报价，盘前与休市不得早于上一个交易日）时回退到同花顺；同花顺同时取快照与分时交叉校验，昨收不一致或最新价相差超过昨收的 0.5% 即视为陈旧数据。都失败时该指数 `available: false`、数值为 `null`、`source: null`，整体仍返回 200；`fallback` 标明是否发生了回退。非交易时段返回最近一个交易日的收盘数据。

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

### 绑定码

- 已登录的网页会话调用 `POST /v1/auth/bind-code` 生成 6 位数字绑定码；有效期 10 分钟，同一用户再次生成会作废旧码。小程序会话调用该接口返回 403 `bind_code_web_required`。生成接口按 IP 每分钟最多 5 次。
- glance 将 `wx.login` 凭据和绑定码提交到 `POST /v1/auth/wechat/bind`，请求体为 `{ "code": "wx.login 的 code", "bindCode": "123456" }`（也接受 `wechatCode` 字段）。网络 code2session 交换完成后，绑定码消费、微信登录方式关联和小程序会话创建在同一数据库事务内完成；返回形状与微信登录一致。
- 绑定码只存服务端密钥 HMAC，数据库泄露不能直接拿明文码使用。生产环境缺少 `BIND_CODE_SECRET` 时绑定码能力返回 503 `bind_code_not_configured`；只有明确的 development/test 环境使用开发默认值。不存在、过期、已使用分别返回 `bind_code_invalid`、`bind_code_expired`、`bind_code_used`；提交入口按 IP 每分钟最多 5 次，成功与失败都计数。
- 除 IP 限流外，数据库持久化两层失败预算：同一 openid 每 24 小时最多 10 次失败，全站每小时最多 300 次失败，达到后返回 429 `rate_limited`，窗口滚动后恢复。失败只统计不存在、过期、已使用；成功不清零计数。策略数值集中在 `src/config.ts` 的 `BIND_CODE_POLICY`。绑定码空间为 10⁶，同时有 N 个有效码、猜测 m 次时命中任意一个的条件概率约为 `1-(1-N/10⁶)^m`；单个有效码下，每身份 10 次约 0.001%，全站 300 次约 0.03%。若同时有 100 个有效码，全站 300 次约 2.96%。码仅有效 10 分钟，上述按整段预算都集中在有效期内估算；IP、身份和全站三层共同限制分散猜测。
- 有效码用部分唯一索引保证唯一；与任一有效码碰撞（包括自己的旧码）最多抽取 5 次，耗尽返回 503 `bind_code_unavailable`，原码保持可用。已使用或过期的历史码允许重用；查找优先有效码，否则按创建时间倒序、同时间按 id 倒序取一条历史记录判定错误。历史只用于创建后 24 小时内的错误识别，超过后返回不存在，并在下一次成功生成时清理。
- 锁顺序：提交先按“全局预算 → openid 预算”锁住预算行，之后生成与提交均遵守“绑定码身份锁 → 微信身份锁（提交）→ 用户行按 id 升序 FOR UPDATE → 绑定码行”。生成清理或退役历史时也先锁相关用户行。提交在用户锁内重新校验码；作废竞态通过 SAVEPOINT 回滚关联与会话，同时保留失败预算。
- 关联复用登录方式的身份锁与冲突规则：空用户自动转移并删除，有持仓用户返回 `login_method_conflict`，当前用户已有其他微信返回 `login_method_type_conflict`，已是当前用户的微信幂等成功。迁移为 `0010`。

### 登录方式管理

均要求已登录（网页 Cookie 或小程序 `Authorization: Bearer`）。

- `GET /v1/me/login-methods` 列出已关联的登录方式类型与展示信息（不含密钥或令牌）。
- 关联 GitHub：`GET /v1/auth/github?intent=link`，未登录返回 401 `unauthorized`。state 绑定发起关联的会话 id（不存令牌）；回调必须携带同一会话且该会话未退出、未过期，否则返回 401 `unauthorized`（换成同一用户的另一会话也拒绝），需重新发起。
- 关联邮箱：`POST /v1/auth/email/link/request` 请求**关联用途**的验证码，`POST /v1/auth/email/link` 提交。同一邮箱的 60 秒冷却与每日上限由登录和关联两种用途**共享**（任一用途请求后，60 秒内再请求任一用途都返回 429 `email_code_cooldown`）；验证码的校验、消费与作废按用途区分：登录码不能用于关联，关联码不能用于登录，新码只作废同用途的旧码。关联入口沿用登录接口的 IP 限流（每分钟 10 次）与防猜码规则（错 5 次作废）。
- 关联目标已属于其他空用户（没有持仓）时，登录方式转移到当前用户，空用户连同其会话、渠道和其余登录方式一起删除；对方有持仓返回 409 `login_method_conflict`，双方数据不变。每个用户每种类型最多一个登录方式，已关联其他标识时返回 409 `login_method_type_conflict`。
- `DELETE /v1/me/login-methods/{type}` 解绑；仅剩一种时返回 409 `login_method_last`，未关联该类型返回 404 `login_method_not_found`。**解绑后再用该标识登录会新建一个用户**（与首次登录相同），不会回到原用户。
- 并发：登录、关联（含转移空用户）、解绑使用同一把按身份（类型 + 外部标识）计算的事务级 advisory lock，统一顺序为先身份锁、再按 id 升序锁用户行。同一身份的登录与关联串行执行：关联在前则登录落在接收用户上；登录在前则其会话属于随后被转移删除的空用户（与先登录再关联的顺序执行结果一致）。

### 行情接口

- **匿名只读 + 限流：** `/v1/funds/*` 与 `/v1/market/*` 不需要登录，按客户端 IP 每分钟 60 次（固定窗口，进程内），超出返回 429 `rate_limited` 与 `Retry-After`。客户端 IP 取 `X-Forwarded-For` 的最右一项（部署时 core 位于 Caddy 之后，由 Caddy 追加），没有该请求头时取连接对端地址；因此 core 不应绕过 Caddy 直接暴露在公网上。
- **缓存：** 搜索结果按 Asia/Shanghai 日期在进程内缓存一天（空结果也缓存，上游失败不缓存），到上海时间零点失效。净值缓存到当天净值公布窗口（以 19:00 Asia/Shanghai 为界，公布前的请求沿用上一个公布日的缓存，公布窗口一到即重新抓取）。大盘指数按指数分别缓存行情（状态不缓存）：所属市场交易中 10 秒、盘前 30 秒、已收盘与休市 5 分钟，不可用的结果只缓存 10 秒，并且一律截断到所属市场的下一个时段边界（开盘、午休、收盘、半日市收市、零点）。
- **统一上游抓取适配器：** 所有上游请求都经过 `src/market/upstream.ts` 的 `UpstreamFetcher`。默认实现 `HttpUpstreamFetcher` 负责浏览器请求头与各上游的 Referer、超时（5 秒）、重试（超时、网络错误、5xx、429、空响应体最多再试 2 次，其他 4xx 不重试）和编码（请求指定或按 `Content-Type` 的 charset 解码，支持 GBK）。上游失败统一返回 502 `upstream_unavailable`，诊断详情只写服务端日志。上游地址属于行情模块内部细节。
- **测试：** 适配器通过 `createApp({ upstream })` 整体替换为 `test/support/recorded-upstream.ts` 的录制样本回放（样本说明见 `test/fixtures/upstream/README.md`）。

公开接口按父 spec 的 API 约定使用版本前缀（`/v1/...`）。健康检查接口没有版本豁免，因此挂在 `/v1/health`；OpenAPI 文档也统一放在 `/v1/openapi`，让 studio / glance 与监控只面对 `/v1` 一个版本化入口，无需额外记忆未版本化的路径。旧路径 `/health` 与 `/openapi` 不再注册，会返回统一的 404。

### 渠道接口

均要求已登录的网页 Cookie 或小程序 `Authorization: Bearer <会话令牌>`，只能操作自己的渠道；访问别人的渠道与不存在的渠道一样返回 404 `not_found`。

| 方法与路径                 | 请求                                                     | 成功响应                                      |
| -------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| `GET /v1/channels`         | —                                                        | 200 `{ items: [{ id, name }] }`，按自定义顺序 |
| `POST /v1/channels`        | `{ name }`                                               | 201 `{ id, name }`，追加到末尾                |
| `PATCH /v1/channels/{id}`  | `{ name }`                                               | 200 `{ id, name }`                            |
| `PUT /v1/channels/order`   | `{ channelIds: [...] }`，全部自己的渠道 id，每个恰好一次 | 200 `{ items: [{ id, name }] }`，按新顺序     |
| `DELETE /v1/channels/{id}` | —                                                        | 204，无响应体                                 |

渠道名去除首尾空白后为 1–100 字符，同一用户下精确匹配、不能重名（包括与预置渠道重名）；冲突返回 409 `channel_name_conflict`，数据库唯一约束保证并发请求下仍成立。新用户预置“支付宝”“天天基金”“未指定”，已有用户迁移后保留原顺序。每个用户恰好一个“未指定”，改名或删除返回 409 `channel_protected`，可以调整其顺序。排序列表缺漏或重复返回 400 `validation_error`，不改变原顺序。

删除时在同一事务中查询持仓：有份额或任意在途交易时返回 409 `channel_has_positions`。只剩已清仓持仓时，先移到该用户的“未指定”，保留持仓 ID、已实现收益和交易历史，再删除渠道。若“未指定”已有同基金持仓，则返回 409 `channel_position_conflict`，所有数据保持原样，避免唯一键冲突及合并历史时改变持仓身份。持仓外键不级联删除。

### 持仓接口

需要登录（会话 Cookie 或 `Authorization: Bearer <token>`），只能操作自己的持仓，别人的持仓返回 404 `not_found`。持仓的唯一键是用户 × 基金 × 渠道（ADR 0001）。

| 接口                           | 请求体                                                                   | 成功响应                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `GET /v1/positions?channelId=` | —                                                                        | 200 `{ items: [Position] }`，按创建先后；`channelId` 可选，渠道不存在或属于别人时 404 `not_found` |
| `GET /v1/positions/{id}`       | —                                                                        | 200 `Position`                                                                                    |
| `POST /v1/positions`           | `{ fundCode, channelId, shares, totalCost \| unitPrice, snapshotDate? }` | 201 `Position`                                                                                    |
| `PATCH /v1/positions/{id}`     | `{ shares, totalCost \| unitPrice }`                                     | 200 `Position`（校准，不生成交易）                                                                |
| `DELETE /v1/positions/{id}`    | —                                                                        | 204，连同交易一起删除                                                                             |

- 数值一律是十进制字符串（JSON 数字返回 400），计算用 bigint 定点、不经过浮点：份额、单价、净值 4 位，金额 2 位，收益率是比值、4 位。总成本与单价必须且只能填一个；用单价时总成本 = 份额 × 单价，返回的 `unitPrice` 总是总成本 ÷ 份额。降精度一律四舍五入（远离零），与 `src/market/quote.ts` 一致。输入的小数位超过精度时返回 400，不替用户舍入。
- 新建要求份额大于 0、基金存在（按基金详情校验，不存在返回 404 `fund_not_found`，上游不可用返回 502 `upstream_unavailable`）、渠道是自己的（否则 404 `not_found`）；`snapshotDate` 缺省为当天（上海时间）。同一组合已有持仓返回 409 `position_exists`，由数据库唯一约束保证并发下只成功一个。校准可以把份额改为 0；仅当没有任何在途交易时才是已清仓，校准保留已实现收益、其成本基数与在途交易。
- 市值 = 份额 × 最新净值（与 `GET /v1/funds/{code}/nav` 同一来源）；持有收益 = 市值 − 总成本；收益率 = 持有收益 ÷ 总成本。暂无净值或行情不可用时 `nav`、`navDate`、`marketValue`、`holdingGain`、`holdingGainRate` 为 `null`（不是 0）；总成本为 0 时收益率为 `null`。

### 今日收益与汇总

持仓的列表、详情、新建与校准响应均增加 `todayGain`、`todayGainRate`、`todayGainStatus`、`todayGainDate`、`previousMarketValue`、`realizedGain`、`totalGain`。今日收益、市值及汇总均以持仓当前已确认份额为准；在途加仓金额通过持仓 `pendingAmount` 展示，确认前不增加份额、成本或收益。

- “今日”是注入时钟的 Asia/Shanghai 日期；当天净值已公布时，`todayGain = 份额 ×（当日净值 − 上一净值）`，状态为 `confirmed`。上一净值取今日之前最近一期已公布净值，不使用上游已舍入的涨跌幅反推涨跌额。
- 当天净值未公布时，`todayGain = 份额 × 上一净值 × 估值涨跌幅`，状态为 `estimated`。复用估值模块的日期、基准核对与回退规则；所有来源不可用、缺上一净值时，收益与收益率为 `null`、状态为 `unavailable`。
- 周末与日历休市日的今日收益为 `unavailable`，不沿用上一交易日的确认收益。交易日盘前没有当日净值时同样为 `unavailable`，与估值接口的 `holiday` / `pre_market` 约定一致；最新净值仍用于市值与持有收益。
- 估值模块提供的百分数先转十进制文本（含指数形式），用 bigint 定点四舍五入到 **6 位百分数小数**，再以调整 scale 的方式除以 100。`份额 × 上一净值` 内部保留完整 **8 位小数**，汇总响应的 `previousMarketValue` 按金额输出 2 位，最终收益只舍入一次到 2 位。`todayGainRate = 已舍入的今日收益 ÷ previousMarketValue`，舍入到 4 位比值；分母为 0 或缺失时为 `null`。
- `realizedGain` 是历次减仓确认累加的已实现收益；`realizedGainCost` 是对应的累计结转成本，均为 2 位小数，从 0 开始，校准、清仓与再次加仓均保留。累计收益 `totalGain = holdingGain + realizedGain`，持有收益缺失则累计收益也为 `null`。迁移 `0011` 为旧持仓补 0。

| 接口                                   | 响应                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /v1/positions/summary?channelId=` | `PositionSummary`，总资产、总成本、今日收益及收益率、持有收益及收益率、已实现收益、累计收益与完整性         |
| `GET /v1/positions/by-fund?channelId=` | `{ items: [FundPositionSummary] }`，同基金跨渠道合并，并增加 `fundCode`、合计 `shares` 与重算的 `unitPrice` |

两个接口均要求登录，只统计当前用户，始终包含已清仓持仓的历史已实现收益；可选 `channelId` 筛选，渠道不存在或属于别人时返回 404 `not_found`，格式不合法返回 400 `validation_error`。固定路径先于持仓详情路由注册。新接口复用 `ErrorCodeSchema` 中的 `unauthorized`、`validation_error`、`not_found`、`database_unavailable`、`internal_error`，无新增错误码。

- 金额合计按每笔持仓已舍入的金额相加；份额与成本也相加。收益率按合计后的分子、分母重算，不平均各持仓收益率。按基金汇总沿用基金首次建仓顺序。
- `totalAssets` 是可取得净值的市值合计；缺净值的持仓不计入总资产和持有收益，已实现收益仍全部相加；累计收益为可用持有收益合计加全部已实现收益，全部净值缺失时为 `null`，`valuationComplete: false`。`totalCost` 仍包含全部持仓；汇总持有收益率仅使用净值可用持仓的成本作分母。
- 不可用的今日收益及其上一市值均不计入今日收益与收益率汇总，`todayGainComplete: false`。`isComplete` 仅在两个完整性字段都为 true 时为 true。汇总状态仅看可计入部分：全为估算是 `estimated`，全为确认是 `confirmed`，两者并存是 `mixed`，无可用收益是 `unavailable`，没有可计算的持仓是 `none`。
- 有持仓但对应数据全部缺失时，该项合计为 `null`；空持仓的金额合计为 `0.00`（上一市值 `0.00`）、收益率为 `null`、状态为 `none`，完整性为 true。

### 今日概览

`GET /v1/overview?channelId=` 需要网页 Cookie 或小程序 Bearer 会话，一次返回 `summary`、`positions`、`indices`、`time` 与 `referenceOnly: true`（仅供参考）。`channelId` 可选，只筛选自己的持仓与汇总；不影响大盘指数。渠道不属于自己或不存在返回 404，格式错误返回 400。

- `summary` 复用 `PositionSummary` 的金额、收益类型、收益率与完整性口径，包含已清仓的历史已实现收益；另含 `risingCount` / `fallingCount`。涨跌只数按有已确认份额的基金去重，同基金跨渠道只计一次，平盘、行情不可用和只有在途加仓的零份额持仓不计入。
- `positions` 隐藏已清仓，按创建顺序逐笔展示，含原持仓字段、`fundName`、`channelName` 与 `quote`。基金名称暂不可用时为 `null`，基金代码仍保留。`quote.type` 为 `estimate`、`nav` 或 `unavailable`，并提供单位水平、百分数涨跌幅、所属日期、来源、来源名称、是否回退及数据时间。`quote.direction` 按未舍入的行情判断 `up` / `down` / `flat`，不可用为 `null`；涨跌只数使用此方向，微小的净值变动即使展示为 `0.00%` 也会计入。行情与今日收益使用同一轮计算的数据；净值只有日期精度，`quote.time` 返回 `YYYY-MM-DD`，估值时间为来源的 ISO 时间。
- 估值不可用时，`quote` 的数值、来源、日期和时间均为 `null`，今日收益为 `null`；该持仓和分母不计入今日收益合计，`todayGainComplete=false`。缺净值另使 `valuationComplete=false`；`isComplete` 为两者合取。盘前、休市不沿用昨日涨跌。
- `indices` 复用大盘指数响应，逐项给出市场状态、来源、时间及可用性；全部来源失败时仍返回四个 `available=false` 的指数，概览保持 200。

### 加仓与交易记录

需要登录，持仓与交易均只能操作自己的，别人的返回 404 `not_found`。

| 接口                                         | 请求体                                                            | 成功响应                                            |
| -------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `POST /v1/positions/{id}/trades`             | `{ type: "buy", amount, feeRate, submittedDate?, beforeCutoff? }` | 201 `Trade`，含申请交易日与预计确认日               |
| `GET /v1/positions/{id}/trades`              | —                                                                 | 200 `{ items: [Trade] }`，按创建先后（同时刻按 id） |
| `DELETE /v1/positions/{id}/trades/{tradeId}` | —                                                                 | 204，撤销即删除                                     |

- `amount` 必须大于 0，是最多 16 位整数、2 位小数的十进制字符串；`feeRate` 是 0–1 的比值字符串，最多 6 位小数（`"0.0015"` 表示 0.15%），返回固定 6 位。不接受 JSON 数字、科学计数法或超精度输入，返回 400 `validation_error`。每次 POST 都新建一笔，网络失败后重试可能重复记录。
- `submittedDate` 缺省为注入时钟的上海日期；`beforeCutoff` 缺省按注入时钟是否早于上海 15:00 判断，15:00 整属于截止后。手动填写提交日时必须同时给出 `beforeCutoff`（支持补录）。非交易日或截止后提交，申请交易日顺延到下一个交易日；之后再按 T+N 推算确认日，全部复用注入的 A 股交易日历。
- N 直接读取现有基金详情的 `settlement.tPlusN`：上游有值则采用；缺失时沿用基金信息的类别默认值，普通/ETF 联接 T+1、QDII T+2。理由：父 spec 明确要求基金规则及类别回退，现有基金信息接口已经提供这一入口。本票不另设一套固定规则。基金不存在返回 404 `fund_not_found`，获取规则失败返回 502 `upstream_unavailable`；日期推算结果随交易保存。
- `Trade` 包含 `type`（`buy/sell/switch_out/switch_in`）、`status`（`pending/confirmed`）、`submittedDate`、`beforeCutoff`、`applicationDate`、`settlementDate`、`amount`（2 位）/`shares`（4 位）、`feeRate`、`confirmedNav`、`confirmedShares`、`switchId`、`source`。支持提交 `buy` 与 `sell`；减仓在途 `amount` 为 `null`，确认后写入到账金额；在途时确认净值与确认份额为 `null`，来源强制为 `web`。来源使用 text，为后续访问令牌名保留空间。
- 持仓详情、列表、新建和校准响应提供 `pendingAmount`（加仓在途金额合计，2 位，缺省 `"0.00"`）；在途不影响份额、成本或持有收益。校准不改变在途交易；删除持仓通过外键级联删除所有交易。
- 仅在上海日期早于确认日、且状态仍为 `pending` 时可撤销，否则返回 409 `trade_not_cancellable`。确认日已到而净值未出时仍为在途，但也不可撤销。减仓沿用同样撤销规则。调仓由 #21 实现，交易表已预留对应类型与调仓关联字段。

### 减仓与已清仓

- `POST /v1/positions/{id}/trades` 支持 `{ type: "sell", shares, feeRate, submittedDate?, beforeCutoff? }`；份额最多 4 位且大于 0，卖出费率为 0–1 的比值、最多 6 位。日期、15:00 截止点、T+N 与加仓共用推算规则。
- 可用份额 = 已确认份额 − 在途减仓/调仓转出预留份额；响应 `pendingShares`、`availableShares` 均为 4 位，后者最低为 0。加仓在途不增加可用份额。超额减仓返回 409 `insufficient_shares`；用户行锁使并发提交与确认、校准、撤销串行化。
- `isCleared` 派生为份额为 0 且没有任何在途交易，不单独存储。`GET /v1/positions` 默认隐藏已清仓，传 `includeCleared=true` 可查看，`false` 与缺省相同；详情始终可访问。汇总与按基金汇总始终包含历史已实现收益，列表开关不影响它们。
- 已清仓持仓提交加仓后因有在途交易而暂不算已清仓；确认后份额增加，恢复持有中，并保留此前已实现收益及其成本基数。任何持仓（含已清仓）都算有数据，不可作为空用户自动合并。

### 交易确认任务

- `app.runSettlement()` 是进程内确认入口，返回 `{ confirmed, pending, failed, failures }` 摘要；任务只用申请交易日的已公布净值，净值缺失时保持在途，单笔行情或数据错误会记录在 `failures` 中并继续处理其他交易。
- 服务入口按 `SETTLEMENT_ROUNDS` 在每个交易日上海时间分轮补跑，默认 21:30、22:30、23:30；每个“日期 + 轮次”只触发一次，非交易日不运行。进程在某轮次之后启动不会补跑已错过的轮次，但会在当天下一轮运行；次日第一轮会继续处理前一天仍在途且已到确认日的交易。需要手动补跑时执行 `pnpm trades:settle`。
- 所有到期交易按申请交易日、创建时间、交易 ID 顺序确认；同日加仓与减仓按创建顺序逐笔使用当前平均成本。某笔缺净值或失败时，同持仓后续交易留在途，其他持仓继续处理。校准保留在途交易；若校准后份额不足以确认减仓，该交易记录失败并保持在途，待修正份额后重跑。
- 减仓到账金额 = 份额 × 申请交易日净值 ×（1 − 费率）；结转成本 = 当前总成本 × 卖出份额 ÷ 卖出前份额。乘积保留全部定点小数，仅在最终到账金额、结转成本分别舍入到 2 位；已实现收益增加到账金额减结转成本，其成本基数增加结转成本，份额与总成本相应减少。卖光时结转全部剩余成本，总成本严格归零。交易写入到账金额、确认净值及确认份额，与持仓在同一事务中更新，重复运行不重复入账。
- 加仓份额使用 `(amount - amount × feeRate / (1 + feeRate)) ÷ applicationDateNav`，中间计算保留 18 位定点小数，最后一次舍入到 4 位份额；成本按原始金额舍入到 2 位累加。

## 测试

```bash
pnpm test        # 全部测试（连接真实 PostgreSQL）
pnpm test:watch  # watch 模式
```

测试唯一的业务入口是在进程内对 core 应用发 HTTP 请求（`app.request(...)`），并连接真实的 PostgreSQL 测试库。因为角色没有 `CREATEDB` 权限，测试隔离用「每个用例一个临时 schema」：建好后在 schema 内跑迁移，用完删除，互不干扰。迁移升级路径的回归测试（`test/integration/*-migration.test.ts`）可以断言迁移命令本身成功或失败；仍不直接断言表结构、迁移记录、内部函数或调用次数，迁移后的行为通过 HTTP 观察。时钟与交易日历替身通过应用的依赖注入在 HTTP 用例中生效。

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

所有错误统一返回 `{ error: { code, message } }`，其中 `code` 是机器可读的错误码、`message` 是人类可读的说明；该结构出现在 OpenAPI 文档的 `Error` schema 中，绑定码接口的错误码包括 `bind_code_web_required`、`bind_code_expired`、`bind_code_used`、`bind_code_invalid`、`bind_code_not_configured`、`bind_code_unavailable`。未捕获的异常由全局处理返回统一的 `internal_error`，诊断详情只留在服务端日志。

## CI

`.github/workflows/ci.yml` 在每个 PR 和每次推送到 main 时运行检查项 `ci`：用 service container 起 PostgreSQL 16，并用 `docker/initdb` 的脚本建出与本机一致的 `test_bafang` 角色（无 `CREATEDB`）；然后依次执行 `pnpm install --frozen-lockfile` → lint → 格式检查 → 类型检查 → 测试 → OpenAPI 契约检查，任一步失败则检查失败。pnpm 版本取自 `package.json` 的 `packageManager` 字段。

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
| `pnpm openapi:generate`             | 重新生成 `openapi.json`    |
| `pnpm openapi:check`                | 检查 `openapi.json` 未漂移 |
| `docker compose up -d`              | 起本地开发数据库           |
