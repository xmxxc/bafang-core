# bafang-core 是唯一数据源，不依赖 Gist 与 Cloudflare Workers

bafang-studio fork 自一个本地优先的应用（数据在浏览器 IndexedDB，经 GitHub Gist 同步，行情经 Cloudflare Workers 代理），我们把它改成由 bafang-core 持有全部用户数据、行情抓取与定时任务（定投执行、交易确认、确认收益），studio 与 glance 只是 core 的客户端，本地存储仅作缓存。原因：微信小程序无法访问 Gist 且只能请求备案域名，网页与小程序必须共用一份数据；MCP 需要在服务端读到持仓；定投与交易确认不能依赖用户当天是否打开页面；国内访问 GitHub、Cloudflare 不稳定。core 部署在自有的国内 VPS，三端分为 bafang-core、bafang-studio、bafang-glance 三个仓库，以 core 导出的 OpenAPI 作为契约。

## Consequences

- studio 合并上游 fund-manager 的更新时，涉及数据层（Dexie 写入、Gist、`workers/`、`api.ts` 直连行情）的改动不能直接采纳，只挑 UI 层的改动。
- core 宕机时网页与小程序都只能显示缓存，不能离线记账。
