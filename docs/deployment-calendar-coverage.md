# 0014 年度日历覆盖部署交接

`0014_calendar_coverage` 创建市场/年份联合唯一的覆盖表，不回填旧数据。已有休市日仍供原调用方使用，但在显式重新导入完整年度清单前，估值与估算今日收益保持不可用。新浪当前缺少基准日期，即使年度覆盖已知也不采纳；有明确基准日期的境内天天基金估值可继续使用，QDII 按日历无法确定处理。

## 升级顺序

在部署使用的同一环境和 PostgreSQL schema 中执行，不输出连接凭据：

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm trading-calendar:import 2026
pnpm trading-calendar:import 2026 --market hk
```

对其他需要的年份准备经核实的完整年度文件，再按市场分别导入，例如：

```bash
pnpm trading-calendar:import 2027 --file /path/to/cn-2027-complete.json
pnpm trading-calendar:import 2027 --market hk --file /path/to/hk-2027-complete.json
```

文件沿用 `{year, market, holidays}` 格式；每条特殊日期包含 `date`、`name`，港股半日市可含 `earlyClose`。操作者负责确认完整性。测试中的空年度是合成清单；生产只可在核实该市场全年确无特殊日期时使用空清单。不要直接写覆盖表，或用部分日期清单证明全年完整。年度导入幂等，同市场同年并发导入串行执行，整体失败时保留原日期集合和覆盖状态。

迁移和导入成功后重启部署中的 core 进程，生产启动加载器才会读取新的日历快照。跨年估值向前寻找基准可能经过上一年，必须同时导入所需历史年度；遇到任何未知年度即返回不可用。旧年度的完整导入证明会保留，导入新年不删除旧年。

## 验证

先验证 `GET /v1/health`。在已覆盖的境内交易日，调用 `GET /v1/funds/estimates?codes=110020,000001,040046`；有合法当日来源时间、明确上一交易日基准日期及已公布净值的境内基金应为 `estimated`，040046 为 `unavailable`。真实来源可能缺少估值或基准，不能只凭 HTTP 200 宣称估值已恢复。

在缺少覆盖的年度，估值应为 `unavailable`、`estimate: null`；持仓没有当天官方净值时，今日收益应为 `unavailable`、金额/收益率为 `null`。市场状态、指数、净值、交易确认仍沿用原 `isTradingDay` 行为；`marketStatus: trading` 不构成年度完整性证明。本次未全局收紧其他接口。

新建空 schema 和从已部署 0013 升级的集成回归均通过 HTTP 验证。升级回归保留已有用户、会话、渠道和休市日，确认迁移不会猜测覆盖，显式导入后估值与持仓估算收益恢复；重复迁移保持幂等。
