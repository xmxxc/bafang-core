# 上游录制样本

测试时统一上游抓取适配器整体替换为 `test/support/recorded-upstream.ts` 里的 `RecordedUpstream`，按请求回放这里的响应体。样本是真实上游响应的原样录制（2026-11-06，Asia/Shanghai），请求都带 `Referer: https://fund.eastmoney.com/`。

| 文件                                          | 上游请求                    | 用途                                               |
| --------------------------------------------- | --------------------------- | -------------------------------------------------- |
| `eastmoney/search-000001.json`                | 基金搜索 `key=000001`       | 按代码搜索；结果里混有同代码的股票与指数，应被过滤 |
| `eastmoney/search-name-huaxiachengzhang.json` | 基金搜索 `key=华夏成长`     | 按名称搜索                                         |
| `eastmoney/search-pinyin-hxcz.json`           | 基金搜索 `key=hxcz`         | 按拼音首字母搜索                                   |
| `eastmoney/search-only-stocks-zzzzqqqxx.json` | 基金搜索 `key=zzzzqqqxx`    | 上游只返回股票，没有基金 → 空列表                  |
| `eastmoney/search-empty.json`                 | 基金搜索 `key=~~`           | 上游返回空数组 → 空列表                            |
| `eastmoney/base-000001.json`                  | 基金基础信息 `FCODE=000001` | 境内基金，上游 T+1                                 |
| `eastmoney/base-040046.json`                  | 基金基础信息 `FCODE=040046` | QDII 的 ETF 联接，上游 T+2                         |
| `eastmoney/base-110020.json`                  | 基金基础信息 `FCODE=110020` | 境内 ETF 联接，上游 T+1                            |
| `eastmoney/base-999999.json`                  | 基金基础信息 `FCODE=999999` | 不存在的基金（`Datas: null`）                      |

上游接口变化时，用 curl 带上同样的 Referer 重新录制对应文件即可；上游失败（超时、5xx、非 JSON、字段缺失）由替身直接构造，不需要样本文件。上游偶尔返回空响应体，录制时若得到空文件需重试。
