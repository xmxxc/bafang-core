# Issue labels

本仓库的 Issue 标签分两类：triage 角色标签与工作流生命周期标签。

## Triage 角色

沿用 `docs/agents/triage-labels.md` 的五个默认 triage 标签：

| Role              | Label             | Meaning                                  |
| ----------------- | ----------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`      | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human` | Requires human implementation            |
| `wontfix`         | `wontfix`         | Will not be actioned                     |

## 生命周期

工作流状态映射到标签（由总控 / live-verify 流程切换）：

| 映射键                          | 标签                |
| ------------------------------- | ------------------- |
| `workflow.in-progress`          | `in-progress`       |
| `workflow.in-review`            | `in-review`         |
| `workflow.changes-requested`    | `changes-requested` |
| `workflow.ready-for-acceptance` | `awaiting-live`     |
| `workflow.live-verified`        | `live-verified`     |
| `workflow.blocked`              | `blocked`           |
