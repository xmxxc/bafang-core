# 生产部署

core 在国内 VPS 上用 Docker Compose 运行，服务定义在 `compose.prod.yaml`：

| 服务       | 镜像                             | 说明                                                                                     |
| ---------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| `postgres` | `postgres:16-alpine`             | 数据卷 `pgdata`；只在 Compose 内部网络可达，不映射端口；首次初始化建出迁移角色与运行角色 |
| `migrate`  | `bafang-core:${BAFANG_CORE_TAG}` | 一次性任务：与 core 同一镜像，用迁移角色执行迁移后退出；只有它拿迁移凭据                 |
| `core`     | `bafang-core:${BAFANG_CORE_TAG}` | 本仓库 `Dockerfile` 构建；`migrate` 成功退出后才启动，用运行角色监听 3000；不映射端口    |
| `caddy`    | `caddy:2-alpine`                 | 唯一对外的服务（80/443），为 `CORE_DOMAIN` 自动签发、续期证书并反代到 `core:3000`        |

## 数据库角色

core 不使用 PostgreSQL 超级用户。postgres 首次初始化（空数据卷）时由 `docker/postgres/initdb/10-bafang-roles.sh` 建出：

| 角色                                       | 属性                                              | 用途                                                                                                    |
| ------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `postgres`                                 | 超级用户                                          | 只用于初始化与运维（备份、恢复、改密码）；密码 `POSTGRES_PASSWORD` 只交给 postgres 服务，不交给 core    |
| `PG_MIGRATION_USER`（默认 `bafang_owner`） | NOSUPERUSER NOCREATEDB NOCREATEROLE，业务库 owner | 一次性 `migrate` 服务执行迁移，拥有全部表                                                               |
| `PGUSER`（默认 `bafang_app`）              | NOSUPERUSER NOCREATEDB NOCREATEROLE               | core 长期运行、日历导入、手动交易确认；只有 `public` 下表的增删改查与序列使用权限，不能建表、改表、删表 |

迁移角色新建的表通过默认权限（`ALTER DEFAULT PRIVILEGES`）自动授予运行角色，升级新增的表无需手工授权。迁移凭据只出现在一次性 `migrate` 服务的配置里；长期运行的 `core` 容器配置（含 Docker 健康检查拉起的进程）中没有迁移凭据，只有运行角色。`core` 依赖 `migrate` 成功退出（`service_completed_successfully`），所以 `dc up -d core` 每次都会先跑迁移，迁移失败时 core 不启动。

取舍：分成两个角色后，即使 core 失陷，也只能读写业务数据，不能改表结构或触及集群其他库；代价是多一组密码、多一个一次性服务，且 `PGSCHEMA` 改为非 `public` 时需要自行给运行角色授权。

镜像在构建阶段装好全部运行依赖，运行时不访问 npm、GitHub 或境外仓库。行情上游、Resend、微信、GitHub OAuth 是 core 的业务出站请求；Caddy 签发证书时需要访问 ACME 服务（默认 Let's Encrypt）。

## 配置

全部配置来自环境变量。把 `.env.production.example` 复制为 `.env.production`，填入真实值（该文件已被 gitignore，不要提交，也不要放进镜像），每次执行 Compose 时用 `--env-file .env.production` 传入。Compose 只把 `compose.prod.yaml` 里 `core.environment` 列出的变量传给 core；空值等同未配置。

| 变量                                                                                              | 必填     | 说明                                                                                                                              |
| ------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `CORE_DOMAIN`                                                                                     | 是       | core 对外域名，例如 `core.example.com`。DNS 指向本机，80/443 对公网开放，国内 VPS 需完成备案                                      |
| `ACME_EMAIL`                                                                                      | 是       | 证书账号邮箱，用于到期提醒                                                                                                        |
| `HTTP_PORT` / `HTTPS_PORT`                                                                        | 否       | 对外端口，默认 80 / 443。自动签发证书要求外部能从 80/443 访问到 Caddy                                                             |
| `BAFANG_CORE_IMAGE` / `BAFANG_CORE_TAG`                                                           | 否       | core 镜像名与标签，默认 `bafang-core:latest`                                                                                      |
| `POSTGRES_PASSWORD`                                                                               | 是       | 超级用户 `postgres` 的密码，只用于初始化与运维                                                                                    |
| `PGDATABASE`                                                                                      | 否       | 业务库名，默认 `bafang`                                                                                                           |
| `PG_MIGRATION_USER` / `PG_MIGRATION_PASSWORD`                                                     | 密码必填 | 迁移角色（库 owner），默认 `bafang_owner`                                                                                         |
| `PGUSER` / `PGPASSWORD`                                                                           | 密码必填 | 运行角色，默认 `bafang_app`                                                                                                       |
| `PGSCHEMA`                                                                                        | 否       | 默认 `public`；初始化脚本只为 `public` 设置运行角色权限                                                                           |
| `SETTLEMENT_ROUNDS`                                                                               | 否       | 交易确认任务的上海时间轮次，默认 `21:30,22:30,23:30`                                                                              |
| `RESEND_API_KEY` / `RESEND_FROM`                                                                  | 是       | 邮箱验证码发信。两项缺一，core 启动即报错退出；`MAIL_TRANSPORT=dev-log` 只把验证码打到日志，生产不要用                            |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_CALLBACK_URL` / `GITHUB_LOGIN_REDIRECT_URL` | 否       | GitHub 网页登录，四项都非空才启用；回调地址用 `https://<CORE_DOMAIN>/v1/auth/github/callback`，并在 GitHub OAuth App 登记同一地址 |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET`                                                             | 否       | 微信小程序登录与扫码登录，两项都非空才启用                                                                                        |
| `WECHAT_QR_TTL_SECONDS`                                                                           | 否       | 扫码登录票据有效秒数（60–600），默认 300                                                                                          |
| `BIND_CODE_SECRET`                                                                                | 生产必填 | 绑定码 HMAC 密钥，用 `openssl rand -base64 48` 生成。留空时绑定码能力禁用                                                         |

数据库相关的值只在 postgres **首次初始化**时生效；之后修改 `.env.production` 不会改动库里已有的角色和密码（需要时以 `postgres` 身份 `ALTER ROLE … PASSWORD …`，再改配置）。值里含 `$` 时用单引号包起来（`PGPASSWORD='a$b'`），否则会被 Compose 当作变量展开。各登录方式的行为见 README。

## 首次部署

下文命令都在 VPS 的部署目录里执行，`dc` 代表：

```bash
alias dc='docker compose -f compose.prod.yaml --env-file .env.production'
```

1. **准备主机。** 安装 Docker Engine 与 Compose 插件；域名解析到本机；防火墙放行 80/tcp、443/tcp、443/udp。

2. **放置部署文件。** 部署目录只需要 `compose.prod.yaml`、`docker/caddy/Caddyfile`、`docker/postgres/initdb/` 和 `.env.production.example`，保持相对路径。从构建机用 `scp` / `rsync` 复制即可，VPS 不需要访问 GitHub：

   ```bash
   rsync -R compose.prod.yaml docker/caddy/Caddyfile docker/postgres/initdb/10-bafang-roles.sh \
     .env.production.example vps:/srv/bafang-core/
   ```

3. **准备镜像。** 在构建机构建 core 镜像，经 SSH 导入 VPS（构建机访问 npm 慢时加 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com`）：

   ```bash
   TAG=$(git rev-parse --short HEAD)
   docker build -t bafang-core:$TAG .
   docker save bafang-core:$TAG | ssh vps docker load
   ```

   `postgres:16-alpine`、`caddy:2-alpine` 在 VPS 上经已配置的镜像加速拉取；拉不到时同样用 `docker save | ssh vps docker load` 导入。

4. **填写配置。**

   ```bash
   cp .env.production.example .env.production
   chmod 600 .env.production
   # 编辑 .env.production：CORE_DOMAIN、ACME_EMAIL、POSTGRES_PASSWORD、PG_MIGRATION_PASSWORD、
   # PGPASSWORD（三个数据库密码各不相同，例如 openssl rand -hex 24）、RESEND_*、BIND_CODE_SECRET，
   # 以及要启用的登录方式；BAFANG_CORE_TAG 设为上一步导入的标签
   dc config --quiet   # 检查配置能否展开，必填项缺失会在这里报错
   ```

5. **启动。** 用 `--no-build`，标签不存在时直接报错，而不是在 VPS 上构建：

   ```bash
   dc up -d --no-build
   dc logs core
   ```

   Compose 先等 postgres 健康，再运行 `migrate`（`dc logs migrate` 依次出现 `running database migrations`、`migrations applied`，随后以 0 退出），最后启动 core 与 caddy（`dc logs core` 出现 `bafang-core listening on …`）。`dc ps -a` 中 `migrate` 显示 `Exited (0)` 属正常。

6. **导入交易日历**（新库是空的，估值与今日收益依赖年度日历覆盖，详见 `docs/deployment-calendar-coverage.md`）。镜像里带有仓库 `data/holidays/` 下的年度文件：

   ```bash
   dc run --rm core trading-calendar:import 2026
   dc run --rm core trading-calendar:import 2026 --market hk
   dc restart core   # 启动时才加载日历快照
   ```

   导入镜像之外的文件时，把文件挂进容器：`dc run --rm -v /path/cn-2027.json:/tmp/cn-2027.json:ro core trading-calendar:import 2027 --file /tmp/cn-2027.json`。

7. **验证。**

   ```bash
   dc ps                                       # core、postgres 为 healthy
   curl -fsS https://<CORE_DOMAIN>/v1/health
   ```

   Caddy 首次签发证书需要几十秒；失败原因看 `dc logs caddy`（常见是 DNS 未生效、80/443 不可达、域名未备案被拦截）。

## 健康检查

`GET /v1/health`：

- 数据库可达时返回 200，`database.connected: true`；数据库不可达时返回 503 `database_unavailable`。core 进程在数据库重启、断连期间保持运行，数据库恢复后自动重连。
- 数据库停止或无响应时，健康检查约 2 秒内返回 503，最长约 4 秒：连接池建立连接的期限为 2 秒（`DB_CONNECT_TIMEOUT_MS`），探针 `SELECT 1` 的期限为 2 秒（`HEALTH_PROBE_TIMEOUT_MS`）。core 与 PostgreSQL 同在 Compose 内网，正常连接与探针都在毫秒级，2 秒足够区分故障；两者之和低于镜像 `HEALTHCHECK` 的 5 秒期限，也让外部轮询（例如 CD 的部署后检查）每次请求设 5 秒超时即可得到明确的 503，而不是超时。
- `upstreams` 列出各行情上游最近一次成功的时间：`eastmoney`（东方财富：基金搜索、基础信息、净值、重仓股名单、联接基金的相关 ETF）、`tiantian`（天天基金估值）、`sina`（新浪：估值、备用重仓股名单）、`tencent`（腾讯行情：指数、重仓股、母 ETF）、`ths`（同花顺行情：备用报价、分时）。自算估值核对母 ETF 身份用的上交所、深交所基金名录不在此列。"成功"指该上游这次给出的数据通过了全部校验并被实际采用：指数报价须通过字段解析、两份数据交叉校验与交易日核对；估值须通过行格式、数值、当日与基准核对；东方财富须返回格式正确的基金或净值行；重仓股名单须解析出完整的季报表；重仓股报价须解析通过、在取回时刻新鲜，并且所有股票处理完后的复核仍保留；母 ETF 报价要等自算估值通过全部核对、被实际返回才算；相关 ETF 须经交易所名录确认；分时须实际返回至少一个估值点。坏数据（字段不可解析、自相矛盾、日期对不上）不算成功；合法空结果（搜索无匹配、基金不存在、来源对某只基金没有估值、空季报、开盘前的空分时）不算失败，但也不刷新时间；由缓存回答的请求不访问上游，同样不刷新。启动以来没成功过为 `null`。时间记在进程内，重启后清空：新浪、同花顺是备用来源，主来源正常时一直为 `null` 属于正常。某个上游长期停在旧时间而同类请求仍在发生，说明上游接口可能失效或持续返回坏数据。

镜像内置 Docker `HEALTHCHECK`，每 30 秒请求一次 `/v1/health`，非 200 记为失败，连续 3 次后容器标为 `unhealthy`（`dc ps` 可见）。

## 升级

1. 按"首次部署"第 3 步构建并导入新标签的镜像。
2. 先备份数据库（见下节）。
3. 把 `.env.production` 里的 `BAFANG_CORE_TAG` 改为新标签，然后：

   ```bash
   dc up -d --no-build core
   dc logs migrate
   dc logs -f core
   ```

   `up core` 会先用新镜像重新运行 `migrate`：迁移幂等，已执行过的不会重跑。**迁移失败时 `migrate` 以非零状态退出，`up` 报 `service "migrate" didn't complete successfully` 并返回非零，core 不会被启动**（新 core 容器停在 Created）；看 `dc logs migrate` 排查，修复后再次 `dc up -d --no-build core`。

4. 验证 `/v1/health`；版本说明里要求重新导入日历等额外步骤时照做（例如 `docs/deployment-calendar-coverage.md`）。

**回滚：** 新版本没有带迁移（`dc logs migrate` 与 `__drizzle_migrations` 条数可确认）时，把 `BAFANG_CORE_TAG` 改回旧标签再 `dc up -d --no-build core` 即可。新版本执行过迁移时，迁移只向前、旧版本不会撤销它们，必须按下节"恢复"流程把升级前的备份恢复到新库再切换，期间 core 保持停止，最后用旧标签创建容器。

只想单独执行迁移时用 `dc up --no-build migrate`（或 `dc run --rm migrate`）。不要用 `dc run --rm core migrate`：core 的配置里没有迁移凭据。

## 数据库备份与恢复

以下命令以超级用户 `postgres` 在 postgres 容器内执行（容器内本地连接免密码）。

**备份**（自定义格式，可选择性恢复，体积小）：

```bash
mkdir -p backups
dc exec -T postgres pg_dump -U postgres -d bafang -Fc > backups/bafang-$(date +%F-%H%M).dump
```

备份包含表的属主、授权与默认权限，恢复后运行角色的权限保持不变。可用 cron 每天执行，并把 `backups/` 同步到另一台机器；备份含用户数据，注意权限。例：

```cron
30 3 * * * cd /srv/bafang-core && docker compose -f compose.prod.yaml --env-file .env.production exec -T postgres pg_dump -U postgres -d bafang -Fc > backups/bafang-$(date +\%F).dump
```

**恢复**（数据损坏，或回滚执行过迁移的升级）。不在原库上就地覆盖：`pg_restore --clean` 只清理备份里有的对象，升级新增、引用旧表的对象（例如带外键的新表）会让清理失败。做法是恢复到新的空库，核验后改名切换：

```bash
# 1. 停止 core，整个恢复期间保持停止。不要用 dc start core：它会直接启动现有的（新版本）容器，
#    绕过 migrate 的依赖顺序；也不要运行 migrate（会对恢复库重跑新版本迁移）
dc stop core

# 2. 建空库（属主为迁移角色），把备份恢复进去；任何错误都中止且不留半成品
dc exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -c 'create database bafang_restore owner bafang_owner'
dc exec -T postgres pg_restore -U postgres -d bafang_restore --exit-on-error --single-transaction \
  < backups/<文件>.dump

# 3. 核验：迁移条数应等于备份时的版本，业务数据计数合理，运行角色可读
for db in bafang bafang_restore; do
  dc exec -T postgres psql -U postgres -d "$db" -Atc \
    "select '$db', (select count(*) from __drizzle_migrations), (select count(*) from users), (select count(*) from trades)"
done
dc exec -T postgres psql -U bafang_app -d bafang_restore -Atc 'select count(*) from users'

# 4. 切换：现库改名留存，恢复库改为正式库名
dc exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres \
  -c 'alter database bafang rename to bafang_before_restore' \
  -c 'alter database bafang_restore rename to bafang'

# 5. 回滚时把 .env.production 的 BAFANG_CORE_TAG 改回备份对应的旧标签；
#    用 up 重新创建容器（标签变化时会替换 migrate 与 core），旧版本的 migrate 不会有新迁移
dc up -d --no-build core
dc ps -a migrate core            # 两者镜像均为旧标签；migrate Exited (0)，core healthy
curl -fsS https://<CORE_DOMAIN>/v1/health

# 6. 确认无误后删除留存库
dc exec -T postgres psql -U postgres -c 'drop database bafang_before_restore'
```

**恢复演练**：定期执行第 2、3 步（库名换成 `bafang_restore_check`），核对后 `drop database bafang_restore_check`，不影响线上库。

库名、角色名按 `.env.production` 调整。备份恢复之后才有的数据会丢失；回滚前先确认可以接受。

## 本机验证

没有真实域名和公网时，用 `compose.local.yaml` 覆盖：Caddy 改用自带内部 CA（`tls internal`，不访问 ACME），端口只绑定 `127.0.0.1:3165`（HTTP）/ `127.0.0.1:3166`（HTTPS）。配置文件放在工作树之外，并用独立的项目名，避免和开发库 `compose.yaml` 冲突：

```bash
cat > /tmp/bafang-local.env <<'EOF'
CORE_DOMAIN=localhost
ACME_EMAIL=ops@example.invalid
BAFANG_CORE_TAG=local
POSTGRES_PASSWORD=local-only-superuser
PG_MIGRATION_PASSWORD=local-only-owner
PGPASSWORD=local-only-app
MAIL_TRANSPORT=dev-log
BIND_CODE_SECRET=local-only-secret
EOF
L='docker compose -p bafang-core-local -f compose.prod.yaml -f compose.local.yaml --env-file /tmp/bafang-local.env'
$L build core
$L up -d --no-build
curl -k https://localhost:3166/v1/health
$L down -v   # 用完删除容器和数据卷
```

本机验证证明镜像、自动迁移、反代与健康检查可用；公网证书签发只能在真实域名上验证。
