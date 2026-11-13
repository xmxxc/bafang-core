#!/bin/sh
# bafang-core 容器入口。
#   serve（默认）              启动 HTTP 服务（运行角色）。不执行迁移：生产由 compose 的一次性
#                              migrate 服务先迁移，成功后才启动 core
#   migrate                    执行数据库迁移后退出；失败以非零退出。用迁移角色的 PGUSER/PGPASSWORD 运行
#   trading-calendar:import …  导入某年交易日历，参数同 pnpm trading-calendar:import
#   trades:settle              手动补跑一次交易确认
# 其他参数原样执行（例如 sh）。
set -eu

command="${1:-serve}"
[ "$#" -gt 0 ] && shift

case "$command" in
  serve)
    exec node --import tsx src/index.ts
    ;;
  migrate)
    echo '[bafang-core] running database migrations'
    exec node --import tsx src/db/migrate.ts
    ;;
  trading-calendar:import)
    exec node --import tsx src/trading-calendar/import.ts "$@"
    ;;
  trades:settle)
    exec node --import tsx src/positions/settlement-cli.ts
    ;;
  *)
    exec "$command" "$@"
    ;;
esac
