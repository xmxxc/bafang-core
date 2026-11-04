# AI 能力只通过 MCP 提供，core 不调用大模型

bafang-core 不调用任何大模型、不保存用户的模型 key，也不提供站内 agent；所有 AI 能力（持仓分析、截图识别导入、调仓）都由用户在自己电脑上的 agent 通过 core 的远程 MCP 接口（`/mcp`，用访问令牌认证）完成。因此 bafang-studio 删除了上游 fund-manager 的截图导入、AI 持仓分析、模型服务商配置与 Telegram AI 提醒。我们曾考虑在 core 中集成 pi（pi-ai + pi-agent-core）做站内 agent，或保留一个转发大模型请求的代理，最终放弃：前者要替用户保管模型 key、承担 agent 运维与审核风险，后者仍需维护代理和配置界面，而愿意用 AI 的用户本来就有自己的 agent。代价是不使用 agent 的用户只能手动录入持仓。

## Consequences

- 带写权限的访问令牌可直接记录交易，没有"交易草稿"环节；交易记录来源（网页或某个令牌），在途期间可撤销。
- 合并上游 fund-manager 时，AI 相关改动一律不采纳。
