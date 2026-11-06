# 上游录制样本

测试时统一上游抓取适配器整体替换为 `test/support/recorded-upstream.ts` 里的 `RecordedUpstream`，按请求回放这里的响应体。样本是真实上游响应的原样录制（2026-11-06，Asia/Shanghai），请求都带 `Referer: https://fund.eastmoney.com/`。

| 文件                                              | 上游请求                                                    | 用途                                               |
| ------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| `eastmoney/search-000001.json`                    | 基金搜索 `key=000001`                                       | 按代码搜索；结果里混有同代码的股票与指数，应被过滤 |
| `eastmoney/search-name-huaxiachengzhang.json`     | 基金搜索 `key=华夏成长`                                     | 按名称搜索                                         |
| `eastmoney/search-pinyin-hxcz.json`               | 基金搜索 `key=hxcz`                                         | 按拼音首字母搜索                                   |
| `eastmoney/search-only-stocks-zzzzqqqxx.json`     | 基金搜索 `key=zzzzqqqxx`                                    | 上游只返回股票，没有基金 → 空列表                  |
| `eastmoney/search-empty.json`                     | 基金搜索 `key=~~`                                           | 上游返回空数组 → 空列表                            |
| `eastmoney/base-000001.json`                      | 基金基础信息 `FCODE=000001`                                 | 境内基金，上游 T+1                                 |
| `eastmoney/base-040046.json`                      | 基金基础信息 `FCODE=040046`                                 | QDII 的 ETF 联接，上游 T+2                         |
| `eastmoney/base-110020.json`                      | 基金基础信息 `FCODE=110020`                                 | 境内 ETF 联接，上游 T+1                            |
| `eastmoney/base-999999.json`                      | 基金基础信息 `FCODE=999999`                                 | 不存在的基金（`Datas: null`）                      |
| `eastmoney/nav-000001-latest.json`                | 历史净值 `fundCode=000001&pageSize=1`                       | 最新一期净值（2026-11-05）                         |
| `eastmoney/nav-999999-latest.json`                | 历史净值 `fundCode=999999&pageSize=1`                       | 不存在的基金（`LSJZList: []`）                     |
| `eastmoney/nav-000001-history-2026-10-06-p*.json` | 历史净值 `fundCode=000001&pageSize=20&startDate=2026-10-06` | 近 1 月，共 2 页（第 2 页仅 1 条）                 |
| `eastmoney/nav-000001-history-2026-08-06-p*.json` | 历史净值 `fundCode=000001&pageSize=20&startDate=2026-08-06` | 近 3 月，共 4 页（第 4 页为空）                    |
| `eastmoney/nav-000001-history-2025-11-06-p*.json` | 历史净值 `fundCode=000001&pageSize=20&startDate=2025-11-06` | 近 1 年，共 13 页（第 13 页仅 2 条）               |
| `eastmoney/nav-999999-history-2026-10-06-p1.json` | 历史净值 `fundCode=999999&pageSize=20&startDate=2026-10-06` | 不存在的基金（`LSJZList: []`）                     |

估值的两级来源也有录制样本（同日 20:06 录制，属收盘后；A 股 2026-11-06 是交易日）：

| 文件                                                  | 上游请求                                                                                                         | 用途                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `tiantian/valuation-000001-110020-040046-999999.json` | 天天基金批量估值 `FundValuationLast?FCODES=000001,110020,040046,999999`，Referer `https://fund.eastmoney.com/`   | 110020 有当天估值（一级成功）；000001 净值已公布、040046 是 QDII，估值字段为 null（一级无估值）；999999 不存在，不出现在 data 里 |
| `sina/fu-000001-110020-040046-999999.txt`             | 新浪 `https://hq.sinajs.cn/list=fu_000001,fu_110020,fu_040046,fu_999999`，Referer `https://finance.sina.com.cn/` | 二级来源；999999 返回空串。上游是 GBK，样本已转成 UTF-8（替身位于适配器解码之后）                                                |

替身 `tiantianSamples` / `sinaSamples` 只回放请求里列出的代码，和真实上游一致；改写字段、失败与空结果都在测试里基于这两份样本构造。

净值上游请求的 Referer 是 `https://fundf10.eastmoney.com/`（不同于搜索/基础信息的 `https://fund.eastmoney.com/`）。

上游接口变化时，用 curl 带上同样的 Referer 重新录制对应文件即可；上游失败（超时、5xx、非 JSON、字段缺失、非零 ErrCode）由替身直接构造（非零 ErrCode 在录制样本基础上改写），不需要样本文件。上游偶尔返回空响应体，录制时若得到空文件需重试。
