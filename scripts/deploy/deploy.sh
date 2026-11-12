#!/usr/bin/env bash
# 把本机已构建的 core 镜像经 SSH 传到 VPS 并切换过去；失败时由 remote-update.sh 回滚。
# CD workflow（.github/workflows/cd.yml）调用它，也可以在构建机上手动执行。说明见 docs/deployment.md 的"持续部署"。
#
#   DEPLOY_SSH_HOST=vps.example.com DEPLOY_SSH_USER=deploy DEPLOY_TAG=<标签> scripts/deploy/deploy.sh
#
# 环境变量：
#   DEPLOY_SSH_HOST             必填，VPS 地址
#   DEPLOY_SSH_USER             必填，SSH 用户（需能执行 docker）
#   DEPLOY_TAG                  必填，要部署的镜像标签，镜像须已在本机
#   DEPLOY_IMAGE                镜像名，默认 bafang-core
#   DEPLOY_SSH_PORT             默认 22
#   DEPLOY_PATH                 VPS 上的部署目录，默认 /srv/bafang-core
#   DEPLOY_SSH_KEY_FILE         私钥文件；不设时用 ssh 默认配置
#   DEPLOY_SSH_KNOWN_HOSTS_FILE known_hosts 文件；不设时用 ssh 默认配置。始终严格校验主机密钥
#   DEPLOY_HEALTH_TIMEOUT       健康检查超时秒数，默认 180
set -euo pipefail

fail() {
  printf '[deploy] 错误：%s\n' "$*" >&2
  exit 1
}

missing=()
for name in DEPLOY_SSH_HOST DEPLOY_SSH_USER DEPLOY_TAG; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done
((${#missing[@]} == 0)) || fail "缺少环境变量：${missing[*]}"

image=${DEPLOY_IMAGE:-bafang-core}
tag=$DEPLOY_TAG
port=${DEPLOY_SSH_PORT:-22}
path=${DEPLOY_PATH:-/srv/bafang-core}
timeout=${DEPLOY_HEALTH_TIMEOUT:-180}

# 这些值会拼进远端命令行，只接受常规字符，避免远端 shell 解释。
[[ "$image" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "DEPLOY_IMAGE 含非法字符"
[[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] || fail "DEPLOY_TAG 含非法字符"
[[ "$path" =~ ^/[A-Za-z0-9._/-]*$ ]] || fail "DEPLOY_PATH 必须是只含常规字符的绝对路径"
[[ "$port" =~ ^[0-9]+$ ]] || fail "DEPLOY_SSH_PORT 必须是数字"
[[ "$timeout" =~ ^[0-9]+$ ]] || fail "DEPLOY_HEALTH_TIMEOUT 必须是数字"

docker image inspect "$image:$tag" >/dev/null 2>&1 || fail "本机没有镜像 $image:$tag"

ssh_cmd=(ssh -p "$port" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20)
[[ -n "${DEPLOY_SSH_KEY_FILE:-}" ]] && ssh_cmd+=(-i "$DEPLOY_SSH_KEY_FILE" -o IdentitiesOnly=yes)
[[ -n "${DEPLOY_SSH_KNOWN_HOSTS_FILE:-}" ]] && ssh_cmd+=(-o UserKnownHostsFile="$DEPLOY_SSH_KNOWN_HOSTS_FILE")
ssh_cmd+=("$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST")

echo "[deploy] 传输镜像 $image:$tag 到 VPS（docker save | ssh docker load）"
docker save "$image:$tag" | gzip -1 | "${ssh_cmd[@]}" docker load

echo "[deploy] 在 VPS 的 $path 切换版本"
"${ssh_cmd[@]}" sh -s -- "$path" "$image" "$tag" "$timeout" <"$(dirname "$0")/remote-update.sh"
