#!/bin/sh
# bafang-core 容器入口。
#   serve（默认）              先执行数据库迁移，成功后启动 HTTP 服务；迁移失败则以非零退出，不带病启动
#   migrate                    只执行迁移
#   trading-calendar:import …  导入某年交易日历，参数同 pnpm trading-calendar:import
#   trades:settle              手动补跑一次交易确认
# 其他参数原样执行（例如 sh）。
set -eu

command="${1:-serve}"
[ "$#" -gt 0 ] && shift

case "$command" in
  serve)
    echo '[bafang-core] running database migrations'
    node --import tsx src/db/migrate.ts
    exec node --import tsx src/index.ts
    ;;
  migrate)
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
