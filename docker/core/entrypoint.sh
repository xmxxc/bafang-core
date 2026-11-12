#!/bin/sh
# bafang-core 容器入口。
#   serve（默认）              先用迁移角色执行数据库迁移，成功后用运行角色启动 HTTP 服务；
#                              迁移失败则以非零退出，不带病启动
#   migrate                    只执行迁移（迁移角色）
#   trading-calendar:import …  导入某年交易日历（运行角色），参数同 pnpm trading-calendar:import
#   trades:settle              手动补跑一次交易确认（运行角色）
# 其他参数原样执行（例如 sh）。
#
# 迁移角色取 PG_MIGRATION_USER / PG_MIGRATION_PASSWORD，未设置时退回 PGUSER / PGPASSWORD
# （单角色部署）。除 migrate 外，进程启动前都会从环境中移除迁移角色凭据。
set -eu

migrate() {
  PGUSER="${PG_MIGRATION_USER:-$PGUSER}" PGPASSWORD="${PG_MIGRATION_PASSWORD:-$PGPASSWORD}" \
    node --import tsx src/db/migrate.ts
}

runtime() {
  exec env -u PG_MIGRATION_USER -u PG_MIGRATION_PASSWORD "$@"
}

command="${1:-serve}"
[ "$#" -gt 0 ] && shift

case "$command" in
  serve)
    echo '[bafang-core] running database migrations'
    migrate
    runtime node --import tsx src/index.ts
    ;;
  migrate)
    migrate
    ;;
  trading-calendar:import)
    runtime node --import tsx src/trading-calendar/import.ts "$@"
    ;;
  trades:settle)
    runtime node --import tsx src/positions/settlement-cli.ts
    ;;
  *)
    runtime "$command" "$@"
    ;;
esac
