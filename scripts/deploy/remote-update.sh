#!/bin/sh
# 在 VPS 上切换 core 到指定镜像标签；健康检查不过则回滚到切换前的镜像。说明见 docs/deployment.md 的"持续部署"。
#
#   sh remote-update.sh <部署目录> <镜像名> <标签> [部署检查秒数] [回滚复检秒数]
#
# 通常由 scripts/deploy/deploy.sh 经 `ssh … sh -s -- … < remote-update.sh` 执行，脚本本身不需要放到 VPS 上。
# 前提：部署目录里有 compose.prod.yaml 与 .env.production，镜像 <镜像名>:<标签> 已经 docker load 进来。
#
# 流程：
#   1. 记录当前 core 容器实际运行的镜像 ID（不可变），打上本地标签 <镜像名>:rollback 作为回滚目标。
#      不用标签字符串：同一标签重新 docker load 后会指向新镜像，旧容器却还在用原来的镜像
#   2. 确保 postgres 运行并健康，以超级用户 postgres 备份业务库到 backups/pre-deploy-<时间>-<标签>.dump；
#      数据库起不来或备份失败都拒绝部署，core 不切换
#   3. 先用新镜像单独跑一次性迁移服务 migrate（`run --rm migrate`），以它的退出码为准。
#      迁移失败：旧 core 容器没有动过、继续服务，记录失败并以非零退出，不回滚。
#      不能直接 `up core` 了事：Compose 会先删掉旧 core、建好新容器，再跑 migrate，迁移失败时旧版本已经停了
#   4. 迁移成功后用环境变量覆盖 BAFANG_CORE_IMAGE / BAFANG_CORE_TAG 执行 `up -d --no-build core`
#      （Compose 会再跑一次 migrate，已执行过的迁移不会重跑）
#   5. 在容器内轮询 /v1/health，按墙钟截止时间判断：部署检查默认 180 秒，单次请求最多 5 秒且不超过剩余时间
#   6. 通过：把新镜像名、标签写回 .env.production，之后手动执行 Compose 也用新版本
#      core 创建/启动失败或健康检查不过：打印日志，停止 core，用 <镜像名>:rollback 重建容器并复检（默认 120 秒），
#      通过后把 .env.production 写成 <镜像名>:rollback，然后以非零退出
#   成功部署和成功回滚后都核对：.env.production 展开出的镜像 ID 必须等于运行中 core 的镜像 ID
# 自动回滚只换镜像、不恢复数据库：新版本的迁移已经执行，旧版本与新结构不兼容时按部署文档手动恢复备份。
# 每次结果追加到部署目录的 deploy-history.log。
#
# 脚本经 stdin 传给远端 shell：流程包在 main 里、最后一行才调用，shell 读完整个脚本才开始执行；
# docker 命令另外显式接 /dev/null，避免 docker compose exec 等子进程读走 stdin。
set -eu

# 等待 postgres 健康的上限（秒）
DB_READY_TIMEOUT=120

log() { printf '[deploy] %s\n' "$*"; }

fail() {
  printf '[deploy] 错误：%s\n' "$*" >&2
  exit 1
}

dc() { docker compose -f compose.prod.yaml --env-file .env.production "$@" </dev/null; }

now() { date +%s; }

min() { if [ "$1" -lt "$2" ]; then echo "$1"; else echo "$2"; fi; }

# record <镜像> <结果>：一行"时间 镜像 结果"。
record() { printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >>deploy-history.log; }

# 打印失败排查用的日志：core，以及存在时的一次性迁移服务 migrate。
show_logs() {
  services=$(dc config --services 2>/dev/null | grep -Ex 'migrate|core' || true)
  # shellcheck disable=SC2086 # 服务名逐个作为参数
  dc logs --no-color --tail 80 ${services:-core} || true
}

# 切换到 <镜像名>:<标签>：Compose 发现镜像变化会删除旧容器、用该镜像新建 core 容器；
# core depends_on 一次性迁移服务 migrate，up 会先用同一镜像跑完迁移。
switch_to() {
  BAFANG_CORE_IMAGE=$1 BAFANG_CORE_TAG=$2 dc up -d --no-build core
}

# wait_healthy <秒数>：从调用时起算墙钟截止时间。单次请求（含 docker compose exec 开销，由 timeout 限住）
# 和间隔都不超过剩余时间，总耗时不超过上限（另加进程收尾的少许误差）。
wait_healthy() {
  deadline=$(($(now) + $1))
  while :; do
    left=$((deadline - $(now)))
    [ "$left" -gt 0 ] || return 1
    if timeout "$(min 10 "$left")" docker compose -f compose.prod.yaml --env-file .env.production \
      exec -T core wget -q -T "$(min 5 "$left")" -O /dev/null "http://127.0.0.1:3000/v1/health" \
      </dev/null >/dev/null 2>&1; then
      return 0
    fi
    left=$((deadline - $(now)))
    [ "$left" -gt 0 ] || return 1
    sleep "$(min 3 "$left")"
  done
}

# 把 KEY=VALUE 写回 .env.production：已有该行则替换，否则追加；原地覆盖以保留文件权限。
persist() {
  tmp=$(mktemp)
  if grep -q "^$1=" .env.production; then
    sed "s|^$1=.*|$1=$2|" .env.production >"$tmp"
  else
    cat .env.production >"$tmp"
    printf '%s=%s\n' "$1" "$2" >>"$tmp"
  fi
  cat "$tmp" >.env.production
  rm -f "$tmp"
}

# 先让 postgres 运行并通过健康检查，再以超级用户 postgres 备份业务库（容器内的 BAFANG_DATABASE，取自 PGDATABASE）。
# 不用 core 的运行角色或迁移角色：备份要完整包含属主、授权与默认权限。
# .env.production 里 KEY 的值（persist 保证每个 KEY 只有一行）。
env_value() { sed -n "s/^$1=//p" .env.production | tail -n 1; }

# 核对持久配置：.env.production 展开出的 core 镜像必须与实际运行的 core 容器是同一个镜像 ID，
# 否则之后手动执行 `dc up` 会换成别的镜像。只比较 ID，不比较标签名。
check_persisted() {
  target_ref="$(env_value BAFANG_CORE_IMAGE):$(env_value BAFANG_CORE_TAG)"
  target_id=$(docker image inspect -f '{{.Id}}' "$target_ref" </dev/null 2>/dev/null || true)
  running_id=$(docker inspect -f '{{.Image}}' "$(dc ps -q core)" </dev/null 2>/dev/null || true)
  if [ -z "$running_id" ] || [ "$target_id" != "$running_id" ]; then
    fail ".env.production 指向 $target_ref（${target_id:-不存在}），与运行中的 core 镜像 ${running_id:-（无）} 不一致，请手动修正"
  fi
  log ".env.production 指向 $target_ref，与运行中的 core 镜像一致（$running_id）"
}

backup_database() {
  log "确保 postgres 运行并健康（最多 ${DB_READY_TIMEOUT}s）"
  dc up -d --no-build --wait --wait-timeout "$DB_READY_TIMEOUT" postgres ||
    fail "postgres 未能启动或 ${DB_READY_TIMEOUT}s 内未就绪，拒绝部署，core 未切换"
  mkdir -p backups
  file="backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)-$tag.dump"
  # shellcheck disable=SC2016 # 变量在 postgres 容器里展开
  if ! dc exec -T postgres sh -c 'pg_dump -U postgres -d "$BAFANG_DATABASE" -Fc' >"$file"; then
    rm -f "$file"
    fail "部署前备份数据库失败，拒绝部署，core 未切换"
  fi
  chmod 600 "$file"
  log "已备份数据库到 $file"
}

main() {
  [ "$#" -ge 3 ] || fail "用法：remote-update.sh <部署目录> <镜像名> <标签> [部署检查秒数] [回滚复检秒数]"
  deploy_path=$1
  image=$2
  tag=$3
  health_timeout=${4:-180}
  rollback_timeout=${5:-120}

  case "$health_timeout" in '' | *[!0-9]* | 0) fail "部署检查秒数必须是正整数：$health_timeout" ;; esac
  case "$rollback_timeout" in '' | *[!0-9]* | 0) fail "回滚复检秒数必须是正整数：$rollback_timeout" ;; esac
  # 镜像名、标签会写回 .env.production，只接受常规字符；标签 rollback 留给回滚目标。
  case "$image" in '' | *[!A-Za-z0-9._/-]*) fail "镜像名含非法字符：$image" ;; esac
  case "$tag" in
    '' | *[!A-Za-z0-9._-]*) fail "标签含非法字符：$tag" ;;
    rollback) fail "标签 rollback 保留给回滚目标" ;;
  esac
  rollback_ref="$image:rollback"

  cd "$deploy_path" || fail "部署目录不存在：$deploy_path"
  [ -f compose.prod.yaml ] || fail "$deploy_path 下缺少 compose.prod.yaml"
  [ -f .env.production ] || fail "$deploy_path 下缺少 .env.production（见 docs/deployment.md 的首次部署）"

  docker image inspect "$image:$tag" </dev/null >/dev/null 2>&1 || fail "VPS 上没有镜像 $image:$tag"

  # 回滚目标：当前 core 容器（含已停止的）实际运行的镜像 ID。
  prev_id=
  prev_ref=
  cid=$(dc ps -a -q core)
  if [ -n "$cid" ]; then
    prev_ref=$(docker inspect -f '{{.Config.Image}}' "$cid" </dev/null)
    prev_id=$(docker inspect -f '{{.Image}}' "$cid" </dev/null)
    docker image inspect "$prev_id" </dev/null >/dev/null 2>&1 ||
      fail "当前版本的镜像 $prev_id 已不在本机，无法保证回滚，停止部署"
    docker tag "$prev_id" "$rollback_ref" </dev/null
    log "当前版本：$prev_ref（$prev_id），已标记为回滚目标 $rollback_ref"
  else
    log "当前没有 core 容器，本次失败时无法回滚"
  fi

  backup_database

  # 先单独迁移：失败时旧 core 不受影响，继续服务。
  if dc config --services | grep -qx migrate; then
    log "用 $image:$tag 执行数据库迁移（旧版本 core 继续服务）"
    migrate_status=0
    BAFANG_CORE_IMAGE=$image BAFANG_CORE_TAG=$tag dc run --rm -T migrate || migrate_status=$?
    if [ "$migrate_status" -ne 0 ]; then
      record "$image:$tag" migrate-failed
      state=
      [ -n "$cid" ] && state=$(docker inspect -f '{{.State.Status}}' "$cid" </dev/null 2>/dev/null || echo 已不存在)
      fail "迁移失败（migrate 退出码 $migrate_status），未切换；旧 core 容器 ${prev_ref:-（无）}：${state:-（无）}"
    fi
  fi

  log "切换到 $image:$tag，健康检查上限 ${health_timeout}s"
  if switch_to "$image" "$tag"; then
    if wait_healthy "$health_timeout"; then
      persist BAFANG_CORE_IMAGE "$image"
      persist BAFANG_CORE_TAG "$tag"
      check_persisted
      record "$image:$tag" deployed
      log "健康检查通过，已部署 $image:$tag"
      return 0
    fi
    log "新版本 $image:$tag 在 ${health_timeout}s 内未通过健康检查，最近日志："
  else
    log "切换到 $image:$tag 失败（core 未能创建或启动），最近日志："
  fi
  show_logs
  record "$image:$tag" failed
  dc stop core || true

  [ -n "$prev_id" ] || fail "没有可回滚的旧版本，core 已停止，请手动处理"

  log "回滚到 $rollback_ref（$prev_id，只换镜像，不恢复数据库），复检上限 ${rollback_timeout}s"
  if switch_to "$image" rollback && wait_healthy "$rollback_timeout"; then
    record "$prev_ref@$prev_id" rolled-back
    # 回滚成功后始终把 .env.production 写成实际运行的回滚身份：原来写的标签可能已被
    # 同名新镜像覆盖（包括前几次失败部署留下的情况），之后手动执行 Compose 会起坏镜像。
    persist BAFANG_CORE_IMAGE "$image"
    persist BAFANG_CORE_TAG rollback
    check_persisted
    fail "部署 $image:$tag 失败，已回滚到原镜像 $prev_id（原标签 $prev_ref，现以 $rollback_ref 运行）并通过健康检查"
  fi
  record "$prev_ref@$prev_id" rollback-failed
  show_logs
  fail "部署 $image:$tag 失败，回滚到原镜像 $prev_id（原标签 $prev_ref）后 ${rollback_timeout}s 内仍未通过健康检查，请立即手动处理"
}

main "$@"
