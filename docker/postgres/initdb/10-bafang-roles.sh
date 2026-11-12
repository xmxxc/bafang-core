#!/bin/sh
# 生产库首次初始化（只在空数据卷上执行一次）：建出两个非超级用户角色和业务库。
#   迁移角色（库的 owner）：执行迁移、拥有全部表；
#   运行角色：core 长期运行用，只有表数据的增删改查与序列使用权限，不能改表结构。
# 两者都是 NOSUPERUSER NOCREATEDB NOCREATEROLE。超级用户 postgres 只留给初始化与运维（备份/恢复）。
# 之后迁移角色新建的表，通过默认权限自动授予运行角色。
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner="$BAFANG_MIGRATION_USER" -v owner_password="$BAFANG_MIGRATION_PASSWORD" \
  -v app="$BAFANG_APP_USER" -v app_password="$BAFANG_APP_PASSWORD" \
  -v db="$BAFANG_DATABASE" <<'SQL'
CREATE ROLE :"owner" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'owner_password';
CREATE ROLE :"app" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
CREATE DATABASE :"db" OWNER :"owner";
\connect :"db"
GRANT USAGE ON SCHEMA public TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app";
SQL
