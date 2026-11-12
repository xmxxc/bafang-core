#!/bin/sh
# 在 VPS 上切换 core 到指定镜像标签；健康检查不过则回滚到切换前的镜像。说明见 docs/deployment.md 的"持续部署"。
#
#   sh remote-update.sh <部署目录> <镜像名> <标签> [健康检查超时秒数]
#
# 通常由 scripts/deploy/deploy.sh 经 `ssh … sh -s -- … < remote-update.sh` 执行，脚本本身不需要放到 VPS 上。
# 前提：部署目录里有 compose.prod.yaml 与 .env.production，镜像 <镜像名>:<标签> 已经 docker load 进来。
#
# 流程：
#   1. 记录当前 core 容器实际使用的镜像，作为回滚目标；没有 core 容器时本次失败无法回滚
#   2. postgres 在运行时先备份数据库到 backups/pre-deploy-<时间>-<标签>.dump，备份失败则不部署
#   3. 用环境变量覆盖 BAFANG_CORE_IMAGE / BAFANG_CORE_TAG 执行 `up -d --no-build core`；新容器启动时自动迁移
#   4. 在容器内轮询 /v1/health（每次请求 5 秒超时），直到返回 200 或总超时
#   5. 通过：把新镜像名、标签写回 .env.production，之后手动执行 Compose 也用新版本
#      未通过：打印新容器日志，停止 core，用旧标签 `up -d --no-build core` 重建容器并再次检查健康，然后以非零退出
# 自动回滚只换镜像、不恢复数据库：新版本的迁移已经执行，旧版本与新结构不兼容时按部署文档手动恢复备份。
# 每次结果追加到部署目录的 deploy-history.log。
#
# 脚本经 stdin 传给远端 shell：流程包在 main 里、最后一行才调用，shell 读完整个脚本才开始执行；
# docker 命令另外显式接 /dev/null，避免 docker compose exec 等子进程读走 stdin。
set -eu

log() { printf '[deploy] %s\n' "$*"; }

fail() {
  printf '[deploy] 错误：%s\n' "$*" >&2
  exit 1
}

dc() { docker compose -f compose.prod.yaml --env-file .env.production "$@" </dev/null; }

record() { printf '%s %s:%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" >>deploy-history.log; }

# 切换到 <镜像名>:<标签>：Compose 发现镜像变化会删除旧容器、用该镜像新建 core 容器。
switch_to() {
  BAFANG_CORE_IMAGE=$1 BAFANG_CORE_TAG=$2 dc up -d --no-build core
}

wait_healthy() {
  elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    if dc exec -T core wget -q -T 5 -O /dev/null "http://127.0.0.1:3000/v1/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  return 1
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

backup_database() {
  if [ -z "$(dc ps -q --status running postgres)" ]; then
    log "postgres 未运行，跳过部署前备份"
    return 0
  fi
  mkdir -p backups
  file="backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)-$tag.dump"
  # shellcheck disable=SC2016 # 变量在 postgres 容器里展开
  if ! dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$file"; then
    rm -f "$file"
    fail "部署前备份数据库失败，未切换版本"
  fi
  chmod 600 "$file"
  log "已备份数据库到 $file"
}

main() {
  [ "$#" -ge 3 ] || fail "用法：remote-update.sh <部署目录> <镜像名> <标签> [超时秒数]"
  deploy_path=$1
  image=$2
  tag=$3
  timeout=${4:-180}

  case "$timeout" in '' | *[!0-9]*) fail "超时秒数必须是正整数：$timeout" ;; esac
  # 镜像名、标签会写回 .env.production，只接受常规字符。
  case "$image" in '' | *[!A-Za-z0-9._/-]*) fail "镜像名含非法字符：$image" ;; esac
  case "$tag" in '' | *[!A-Za-z0-9._-]*) fail "标签含非法字符：$tag" ;; esac

  cd "$deploy_path" || fail "部署目录不存在：$deploy_path"
  [ -f compose.prod.yaml ] || fail "$deploy_path 下缺少 compose.prod.yaml"
  [ -f .env.production ] || fail "$deploy_path 下缺少 .env.production（见 docs/deployment.md 的首次部署）"

  docker image inspect "$image:$tag" </dev/null >/dev/null 2>&1 || fail "VPS 上没有镜像 $image:$tag"

  # 回滚目标取当前 core 容器（含已停止的）实际使用的镜像，而不是 .env.production 里写的值。
  prev_ref=
  cid=$(dc ps -a -q core)
  if [ -n "$cid" ]; then
    prev_ref=$(docker inspect -f '{{.Config.Image}}' "$cid" </dev/null)
  fi
  if [ -n "$prev_ref" ]; then
    log "当前版本：$prev_ref"
    docker image inspect "$prev_ref" </dev/null >/dev/null 2>&1 ||
      fail "当前版本的镜像 $prev_ref 已不在本机，无法保证回滚，停止部署"
  else
    log "当前没有 core 容器，本次失败时无法回滚"
  fi

  backup_database

  log "切换到 $image:$tag（启动时自动执行数据库迁移）"
  if switch_to "$image" "$tag" && wait_healthy; then
    persist BAFANG_CORE_IMAGE "$image"
    persist BAFANG_CORE_TAG "$tag"
    record "$image" "$tag" deployed
    log "健康检查通过，已部署 $image:$tag"
    return 0
  fi

  log "新版本 $image:$tag 在 ${timeout}s 内未通过健康检查，最近日志："
  dc logs --no-color --tail 80 core || true
  record "$image" "$tag" failed
  dc stop core || true

  [ -n "$prev_ref" ] || fail "没有可回滚的旧版本，core 已停止，请手动处理"

  case "${prev_ref##*/}" in
    *:*) prev_image=${prev_ref%:*} prev_tag=${prev_ref##*:} ;;
    *) prev_image=$prev_ref prev_tag=latest ;;
  esac
  log "回滚到 $prev_image:$prev_tag（只换镜像，不恢复数据库）"
  if switch_to "$prev_image" "$prev_tag" && wait_healthy; then
    record "$prev_image" "$prev_tag" rolled-back
    fail "部署 $image:$tag 失败，已回滚到 $prev_image:$prev_tag 并通过健康检查"
  fi
  record "$prev_image" "$prev_tag" rollback-failed
  dc logs --no-color --tail 80 core || true
  fail "部署 $image:$tag 失败，回滚到 $prev_image:$prev_tag 后仍未通过健康检查，请立即手动处理"
}

main "$@"
