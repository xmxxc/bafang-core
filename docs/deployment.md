# 生产部署

core 在国内 VPS 上用 Docker Compose 运行，由三个服务组成，定义在 `compose.prod.yaml`：

| 服务       | 镜像                             | 说明                                                                              |
| ---------- | -------------------------------- | --------------------------------------------------------------------------------- |
| `postgres` | `postgres:16-alpine`             | 数据卷 `pgdata`；只在 Compose 内部网络可达，不映射端口                            |
| `core`     | `bafang-core:${BAFANG_CORE_TAG}` | 本仓库 `Dockerfile` 构建；启动时先自动迁移，再监听 3000；不映射端口               |
| `caddy`    | `caddy:2-alpine`                 | 唯一对外的服务（80/443），为 `CORE_DOMAIN` 自动签发、续期证书并反代到 `core:3000` |

镜像在构建阶段装好全部运行依赖，运行时不访问 npm、GitHub 或境外仓库。行情上游、Resend、微信、GitHub OAuth 是 core 的业务出站请求；Caddy 签发证书时需要访问 ACME 服务（默认 Let's Encrypt）。

## 配置

全部配置来自环境变量。把 `.env.production.example` 复制为 `.env.production`，填入真实值（该文件已被 gitignore，不要提交，也不要放进镜像），每次执行 Compose 时用 `--env-file .env.production` 传入。Compose 只把 `compose.prod.yaml` 里 `core.environment` 列出的变量传给 core；空值等同未配置。

| 变量                                                                                              | 必填     | 说明                                                                                                                              |
| ------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `CORE_DOMAIN`                                                                                     | 是       | core 对外域名，例如 `core.example.com`。DNS 指向本机，80/443 对公网开放，国内 VPS 需完成备案                                      |
| `ACME_EMAIL`                                                                                      | 是       | 证书账号邮箱，用于到期提醒                                                                                                        |
| `HTTP_PORT` / `HTTPS_PORT`                                                                        | 否       | 对外端口，默认 80 / 443。自动签发证书要求外部能从 80/443 访问到 Caddy                                                             |
| `BAFANG_CORE_IMAGE` / `BAFANG_CORE_TAG`                                                           | 否       | core 镜像名与标签，默认 `bafang-core:latest`                                                                                      |
| `PGUSER` / `PGPASSWORD` / `PGDATABASE`                                                            | 密码必填 | postgres 首次初始化与 core 连接共用。默认用户、库名都是 `bafang`。首次初始化后再改这里不会改动库里已有的密码                      |
| `PGSCHEMA`                                                                                        | 否       | 默认 `public`                                                                                                                     |
| `SETTLEMENT_ROUNDS`                                                                               | 否       | 交易确认任务的上海时间轮次，默认 `21:30,22:30,23:30`                                                                              |
| `RESEND_API_KEY` / `RESEND_FROM`                                                                  | 是       | 邮箱验证码发信。两项缺一，core 启动即报错退出；`MAIL_TRANSPORT=dev-log` 只把验证码打到日志，生产不要用                            |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_CALLBACK_URL` / `GITHUB_LOGIN_REDIRECT_URL` | 否       | GitHub 网页登录，四项都非空才启用；回调地址用 `https://<CORE_DOMAIN>/v1/auth/github/callback`，并在 GitHub OAuth App 登记同一地址 |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET`                                                             | 否       | 微信小程序登录与扫码登录，两项都非空才启用                                                                                        |
| `WECHAT_QR_TTL_SECONDS`                                                                           | 否       | 扫码登录票据有效秒数（60–600），默认 300                                                                                          |
| `BIND_CODE_SECRET`                                                                                | 生产必填 | 绑定码 HMAC 密钥，用 `openssl rand -base64 48` 生成。留空时绑定码能力禁用                                                         |

值里含 `$` 时用单引号包起来（`PGPASSWORD='a$b'`），否则会被 Compose 当作变量展开。各登录方式的行为见 README。

## 首次部署

下文命令都在 VPS 的部署目录里执行，`dc` 代表：

```bash
alias dc='docker compose -f compose.prod.yaml --env-file .env.production'
```

1. **准备主机。** 安装 Docker Engine 与 Compose 插件；域名解析到本机；防火墙放行 80/tcp、443/tcp、443/udp。

2. **放置部署文件。** 部署目录只需要 `compose.prod.yaml`、`docker/caddy/Caddyfile` 和 `.env.production.example`，保持相对路径。从构建机用 `scp` / `rsync` 复制即可，VPS 不需要访问 GitHub：

   ```bash
   rsync -R compose.prod.yaml docker/caddy/Caddyfile .env.production.example vps:/srv/bafang-core/
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
   # 编辑 .env.production：CORE_DOMAIN、ACME_EMAIL、PGPASSWORD、RESEND_*、BIND_CODE_SECRET，
   # 以及要启用的登录方式；BAFANG_CORE_TAG 设为上一步导入的标签
   dc config --quiet   # 检查配置能否展开，必填项缺失会在这里报错
   ```

5. **启动。** 用 `--no-build`，标签不存在时直接报错，而不是在 VPS 上构建：

   ```bash
   dc up -d --no-build
   dc logs core
   ```

   日志里依次出现 `running database migrations`、`migrations applied`、`bafang-core listening on …` 即迁移完成、服务就绪。

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
- `upstreams` 列出各行情上游最近一次成功的时间：`eastmoney`（东方财富：基金搜索、基础信息、净值）、`tiantian`（天天基金估值）、`sina`（新浪估值）、`tencent`（腾讯指数行情）、`ths`（同花顺指数行情）。"成功"指响应通过了该来源的格式校验；启动以来没成功过为 `null`。时间记在进程内，重启后清空，只在有对应请求时更新：新浪、同花顺是备用来源，主来源正常时一直为 `null` 属于正常。某个上游长期停在旧时间而同类请求仍在发生，说明上游接口可能失效。

镜像内置 Docker `HEALTHCHECK`，每 30 秒请求一次 `/v1/health`，非 200 记为失败，连续 3 次后容器标为 `unhealthy`（`dc ps` 可见）。

## 升级

1. 按"首次部署"第 3 步构建并导入新标签的镜像。
2. 先备份数据库（见下节）。
3. 把 `.env.production` 里的 `BAFANG_CORE_TAG` 改为新标签，然后：

   ```bash
   dc up -d --no-build core
   dc logs -f core
   ```

   新容器启动时自动执行迁移，迁移幂等，已执行过的不会重跑。**迁移失败时容器以非零状态退出、不会启动 HTTP 服务**；`restart: unless-stopped` 会让它反复重试，`dc ps` 显示 `Restarting`，此时看 `dc logs core` 排查。

4. 验证 `/v1/health`；版本说明里要求重新导入日历等额外步骤时照做（例如 `docs/deployment-calendar-coverage.md`）。

**回滚：** 把 `BAFANG_CORE_TAG` 改回旧标签再 `dc up -d --no-build core`。迁移只向前，如果新版本的迁移改了旧版本不兼容的结构，先按下节恢复升级前的备份，再启动旧标签。

只想单独执行迁移时用 `dc run --rm core migrate`。

## 数据库备份与恢复

**备份**（自定义格式，可选择性恢复，体积小）：

```bash
mkdir -p backups
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > backups/bafang-$(date +%F-%H%M).dump
```

可用 cron 每天执行，并把 `backups/` 同步到另一台机器；备份含用户数据，注意权限。例：

```cron
30 3 * * * cd /srv/bafang-core && docker compose -f compose.prod.yaml --env-file .env.production exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backups/bafang-$(date +\%F).dump
```

**恢复演练**（恢复到临时库核对，不影响线上库）：

```bash
dc exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" bafang_restore_check'
dc exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d bafang_restore_check --no-owner' \
  < backups/<文件>.dump
for db in bafang bafang_restore_check; do
  dc exec -T postgres psql -U bafang -d "$db" -Atc \
    'select count(*) from __drizzle_migrations; select count(*) from users; select count(*) from trades'
done
dc exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" bafang_restore_check'
```

两边计数一致即备份可用（库名、用户名按 `.env.production` 调整）。

**正式恢复**（覆盖线上库，先停 core）：

```bash
dc stop core
dc exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction' \
  < backups/<文件>.dump
dc start core
```

`--single-transaction` 让恢复要么全部成功、要么不改动线上库。core 启动时会对恢复后的库再执行一次迁移，补上备份之后才有的迁移。

## 本机验证

没有真实域名和公网时，用 `compose.local.yaml` 覆盖：Caddy 改用自带内部 CA（`tls internal`，不访问 ACME），端口只绑定 `127.0.0.1:3165`（HTTP）/ `127.0.0.1:3166`（HTTPS）。配置文件放在工作树之外，并用独立的项目名，避免和开发库 `compose.yaml` 冲突：

```bash
cat > /tmp/bafang-local.env <<'EOF'
CORE_DOMAIN=localhost
ACME_EMAIL=ops@example.invalid
BAFANG_CORE_TAG=local
PGPASSWORD=local-only-password
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

## 持续部署

`.github/workflows/cd.yml` 在 main 上的 CI 成功后自动部署，也可以在 Actions 页面选 CD → Run workflow 手动触发（只能选 main）。流程：

1. 在 Actions runner 上按该提交构建镜像 `bafang-core:<提交前 12 位>`。
2. `docker save | gzip | ssh … docker load` 把镜像传到 VPS。VPS 不访问 GitHub 或任何镜像仓库。
3. 经 SSH 在 VPS 的部署目录执行 `scripts/deploy/remote-update.sh`（脚本经 stdin 传过去，不需要事先放到 VPS 上）：
   - 记录当前 core 容器实际使用的镜像，作为回滚目标；
   - postgres 在运行时先备份数据库到 `backups/pre-deploy-<UTC 时间>-<标签>.dump`，备份失败就不部署；
   - 以新标签执行 `up -d --no-build core`，新容器启动时自动迁移；
   - 在容器内轮询 `/v1/health`（每次请求 5 秒超时，总共 180 秒）。通过后把 `BAFANG_CORE_IMAGE`、`BAFANG_CORE_TAG` 写回 `.env.production`，之后手动执行 `dc` 也是新版本；
   - 未通过：打印新容器日志，停止 core，用旧标签 `up -d --no-build core` 重建容器并再次检查健康，然后让 workflow 失败。
4. 每次结果追加到部署目录的 `deploy-history.log`（`deployed` / `failed` / `rolled-back` / `rollback-failed`）。

自动回滚只换回旧镜像，**不恢复数据库**：新版本的迁移已经执行过，旧版本要在新结构上运行。新版本的迁移与旧版本不兼容时，按"升级"一节的回滚方法用部署前备份恢复。

CD 只更新 core 镜像，不同步 `compose.prod.yaml`、`docker/caddy/Caddyfile` 与 `.env.production`。改动这些文件或新增必填配置的 PR，合并前先按"首次部署"第 2、4 步把文件和配置同步到 VPS，否则新镜像会以旧配置启动，健康检查不过就自动回滚。

### 开通

前提：已按"首次部署"在 VPS 上完成一次手动部署，`.env.production` 已填好，服务正常。

1. **部署用户。** 在 VPS 上准备一个能执行 `docker` 的用户（加入 `docker` 组；该组等同 root 权限，这个用户只用于部署），对部署目录有读写权限。

2. **SSH 密钥。** 在自己的机器上生成一对专用密钥，公钥追加到部署用户的 `~/.ssh/authorized_keys`：

   ```bash
   ssh-keygen -t ed25519 -N '' -C bafang-core-cd -f bafang-core-cd
   ssh-copy-id -i bafang-core-cd.pub deploy@<VPS 地址>
   ```

3. **主机密钥。** 取 VPS 的 known_hosts 行，并和 VPS 上 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 的指纹核对一致：

   ```bash
   ssh-keyscan -p 22 <VPS 地址> > bafang-core-cd.known_hosts
   ssh-keygen -lf bafang-core-cd.known_hosts
   ```

   SSH 端口不是 22 时，`ssh-keyscan` 输出的主机名形如 `[地址]:端口`，原样保留。

4. **配置 Actions secrets**（仓库 Settings → Secrets and variables → Actions，或用 `gh`）：

   | Secret                   | 必填 | 说明                                         |
   | ------------------------ | ---- | -------------------------------------------- |
   | `DEPLOY_SSH_HOST`        | 是   | VPS 地址                                     |
   | `DEPLOY_SSH_USER`        | 是   | 第 1 步的部署用户                            |
   | `DEPLOY_SSH_KEY`         | 是   | 第 2 步的私钥全文（`bafang-core-cd`）        |
   | `DEPLOY_SSH_KNOWN_HOSTS` | 是   | 第 3 步的 known_hosts 内容；严格校验主机密钥 |
   | `DEPLOY_SSH_PORT`        | 否   | 默认 22                                      |
   | `DEPLOY_PATH`            | 否   | 部署目录的绝对路径，默认 `/srv/bafang-core`  |

   ```bash
   gh secret set DEPLOY_SSH_HOST --body '<VPS 地址>'
   gh secret set DEPLOY_SSH_USER --body deploy
   gh secret set DEPLOY_SSH_KEY < bafang-core-cd
   gh secret set DEPLOY_SSH_KNOWN_HOSTS < bafang-core-cd.known_hosts
   ```

   配置完删除本地私钥文件。缺少任一必填 secret 时，CD 在第一步以"CD 未开通"失败，不构建、不连接 VPS；在开通之前，main 上每次 CI 成功后的 CD 运行都会这样失败。

5. **首次运行。** Actions → CD → Run workflow，看 Deploy 步骤日志依次出现"当前版本""已备份数据库""健康检查通过"，再按"首次部署"第 7 步从公网验证。

### 手动回滚

自动回滚之外，要退回更早的版本时：

- **重新运行旧版本的 CD。** 在 Actions 里打开那个版本对应的 CD 运行，选 Re-run jobs：它按原提交重新构建、部署，同样有健康检查和自动回滚（GitHub 只允许重新运行 30 天内的运行）。
- **在 VPS 上直接切换。** 部署过的镜像都留在 VPS 上，`deploy-history.log` 里能找到之前 `deployed` 的标签：

  ```bash
  tail deploy-history.log
  docker images bafang-core          # 确认目标标签还在
  dc stop core
  # 把 .env.production 里的 BAFANG_CORE_TAG 改为目标标签
  dc up -d --no-build core
  dc exec -T core wget -q -T 5 -O - http://127.0.0.1:3000/v1/health
  ```

  目标版本与当前数据库结构不兼容时，先按"升级"一节的回滚方法恢复备份。

镜像与部署前备份会一直累积，定期清理：`docker images bafang-core` 查看后用 `docker rmi bafang-core:<标签>` 删除旧标签（保留当前与上一个版本），`backups/pre-deploy-*.dump` 按需保留最近几份。

### 在构建机上手动执行

`scripts/deploy/deploy.sh` 可以脱离 Actions 执行，参数全部来自环境变量（见脚本开头的说明），镜像须已在本机：

```bash
TAG=$(git rev-parse --short=12 HEAD)
docker build -t bafang-core:$TAG .
DEPLOY_SSH_HOST=<VPS 地址> DEPLOY_SSH_USER=deploy DEPLOY_TAG=$TAG scripts/deploy/deploy.sh
```
