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

| 文件                                                  | 上游请求                                                                                                         | 用途                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tiantian/valuation-000001-110020-040046-999999.json` | 天天基金批量估值 `FundValuationLast?FCODES=000001,110020,040046,999999`，Referer `https://fund.eastmoney.com/`   | 每行的 NAV / PDATE 是天天基金已知的最近一期净值。录制时当天净值已公布，110020 的 PDATE 已是 11-06，看不出估值基准，按规则不采纳（回退新浪）；一级成功的用例在测试里把它还原成盘中的样子（PDATE 11-05、NAV 1.7030，取自录制的净值历史）。110020 有当天估值；000001 净值已公布、040046 是 QDII，估值字段为 null（一级无估值）；999999 不存在，不出现在 data 里 |
| `sina/fu-000001-110020-040046-999999.txt`             | 新浪 `https://hq.sinajs.cn/list=fu_000001,fu_110020,fu_040046,fu_999999`，Referer `https://finance.sina.com.cn/` | 二级来源；999999 返回空串。上游是 GBK，样本已转成 UTF-8（替身位于适配器解码之后）                                                                                                                                                                                                                                                                            |

核对估值基准用的净值样本（同日 20:19 录制，东方财富历史净值，Referer `https://fundf10.eastmoney.com/`）：

| 文件                                              | 上游请求                                           | 用途                                                                            |
| ------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `eastmoney/nav-040046-latest-2026-11-06.json`     | `fundCode=040046&pageSize=1`                       | QDII 最新一期是 11-05 的 7.3159；新浪行的基准 7.8140 是 11-04 的净值 → 过期估值 |
| `eastmoney/nav-040046-history-2026-10-06-p*.json` | `fundCode=040046&pageSize=20&startDate=2026-10-06` | 近 1 月，共 2 页，含 11-04 的 7.8140                                            |
| `eastmoney/nav-110020-latest-2026-11-06.json`     | `fundCode=110020&pageSize=1`                       | 当天（11-06）净值已公布 → 基准要从走势里找前一期                                |
| `eastmoney/nav-110020-history-2026-10-06-p*.json` | `fundCode=110020&pageSize=20&startDate=2026-10-06` | 近 1 月，共 2 页，11-05 为 1.7030，与新浪行的基准一致                           |

替身 `tiantianSamples` / `sinaSamples` 只回放请求里列出的代码，和真实上游一致；改写字段、失败与空结果都在测试里基于这两份样本构造。

净值上游请求的 Referer 是 `https://fundf10.eastmoney.com/`（不同于搜索/基础信息的 `https://fund.eastmoney.com/`）。

上游接口变化时，用 curl 带上同样的 Referer 重新录制对应文件即可；上游失败（超时、5xx、非 JSON、字段缺失、非零 ErrCode）由替身直接构造（非零 ErrCode 在录制样本基础上改写），不需要样本文件。上游偶尔返回空响应体，录制时若得到空文件需重试。

## 股票与指数行情

样本录制于 2026-11-06 收盘后（Asia/Shanghai 约 21:05，A 股与港股都已收盘）。交易时段、盘前、休市等场景由注入的时钟与交易日历配合这些样本构造，样本本身不随场景改写；字段缺失、占位值、陈旧数据等异常在测试里基于样本改写。

| 文件                              | 上游请求                                                                     | 用途                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `tencent/indices.txt`             | 腾讯 `qt.gtimg.cn/q=sh000001,sz399001,sz399006,hkHSI`（GBK，已转存为 UTF-8） | 主来源：四个指数的点位与昨收                                                                                 |
| `ths/realhead-<代码>.jsonp`       | 同花顺快照 `d.10jqka.com.cn/v6/realhead/<代码>/last.js`                      | 备用来源的快照（最新价 `10`、昨收 `6`）                                                                      |
| `ths/time-<代码>.jsonp`           | 同花顺分时 `d.10jqka.com.cn/v6/time/<代码>/last.js`                          | 备用来源的分时（交易日 `date`、昨收 `pre`、分时点）                                                          |
| `ths/time-hk_HSI-stale-pre.jsonp` | 同花顺分时 `hk_HSI`                                                          | 实录的陈旧 CDN 响应：分时点是当天的，`pre` 却是几个月前的 26361.07；用来验证交叉校验会拒绝它，不给出假的涨跌 |

腾讯请求的 Referer 是 `https://gu.qq.com/`，同花顺是 `https://stockpage.10jqka.com.cn/`（同花顺还要求浏览器 User-Agent）。同花顺对同一地址偶尔返回空响应体或陈旧数据，录制时需要多取几次并核对昨收。

## #6 基金重仓股真实样本（2026-11-09 采集，Asia/Shanghai）

| 文件                             | 请求                                                                                                                                                    | 说明                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eastmoney/holdings-000001.json` | `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=000001&topline=10&year=&month=&rt=1`，Referer `https://fundf10.eastmoney.com/`     | 东方财富 F10 原始脚本响应；`content` 内 HTML 表格，截止日 `2026-09-30`，表格列含股票代码、股票名称、占净值比例                                                         |
| `tencent/holdings-000001.txt`    | `https://qt.gtimg.cn/q=sz300308,sz002371,sh600519`，Referer `https://gu.qq.com/`                                                                        | 腾讯原始报价响应；`v_<symbol>` 行，价格/昨收/时间字段沿用 `src/market/tencent.ts`                                                                                      |
| `sina/holdings-000001.json`      | `https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getTopHold?format=json&symbol=000001`，Referer `https://finance.sina.com.cn/` | 采集时返回 `result.status.code=0` 且 `result.data=[]`（部分请求超时）；该文件保留为真实空响应证据。未取得可证明的股票行字段，core 不将资产配置或合成边界数据当作重仓股 |

| `sina/holdings-000001-success.json` | 同一新浪 `FdFundService.getTopHold` URL 的真实非空响应（审查采集 2026-11-10） | `result.data.heavy_stock`，真实返回 5 只股票；`zcpz` 为资产配置，解析器不混用 |
| `ths/realhead-sz_300308-holdings.jsonp` / `ths/time-sz_300308-holdings.jsonp` | 同花顺 `realhead/time/sz_300308/last.js` 真实 pair | 真实深市股票备用报价回放 |

### Holdings r5 evidence and boundary cases

The following files are verbatim copies of the independent review's first-party
captures, under `docs/agents/work/ai-coding/p1-core/reports/6-review/evidence-r1/`
in the main checkout (capture metadata: `official-fetch.json`,
`official-fetch-second.json`, `official-fetch-hk.json`):

- `sina/holdings-000001-page.txt`: decoded UTF-8 official page,
  https://finance.sina.com.cn/fund/quotes/000001/bc.shtml,
  captured 2026-11-10 05:11:56 UTC (`sina-page-utf8.txt`). Its
  `sdzc_blk` / `fund_sdzc_table` contains ten stocks and a quarter date;
  the separately preserved JSON API contains only five and is not the full fallback.
- `eastmoney/holdings-005827.txt`, `eastmoney/holdings-110011.txt`:
  https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=005827&topline=10&year=&month=&rt=1
  (respectively `code=110011`), captured 2026-11-10 05:14:29 UTC.
  Each raw script contains several quarters, including five-digit HK stock codes.
- `ths/realhead-hs_600519-holdings.jsonp` and
  `ths/time-hs_600519-holdings.jsonp`: original official
  https://d.10jqka.com.cn/v6/realhead/hs_600519/last.js and
  https://d.10jqka.com.cn/v6/time/hs_600519/last.js, captured
  2026-11-10 05:11:08 / 05:11:11 UTC. Along with the previously copied
  `sz_300308` pair, tests replay these at 13:12 Shanghai and again at 14:00
  to verify fresh fallback and stale rejection with the same raw bytes.

`eastmoney/holdings-000009-empty.txt` was captured in this implementation
session on 2026-11-10 UTC using the production `HttpUpstreamFetcher`, URL
https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=000009&topline=10&year=&month=&rt=1
and the F10 Referer. The successful response is exactly
`var apidata={ content:"",arryear:[],curyear:2026};`.
A second request for 000198 independently returned the same successful empty
shape. This recognized protocol means no available stock report (404), not a
transport or parsing failure (502). A plain curl request first returned 404;
that transport error was not used as evidence of an empty report.

Inline HTML/script/quote builders in `holdings.test.ts` are **synthetic**,
protocol-shaped mutations for error, field, date, price and time boundaries.
They are not live upstream success captures. The original Tencent fixture is
GBK and contains lunch-stamped snapshots at 12:05 on 2026-11-10; its prices are
asserted at 12:06 and the same bytes must become unavailable at 14:00.

### Holdings r6: original three-character stock identifier

`eastmoney/holdings-040046.txt` is a verbatim copy of the review's first-party
`evidence-r2/spec-source/040046.txt`. URL:
https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=040046&topline=10&year=&month=&rt=1
(F10 Referer); HTTP 200, UTF-8, captured 2026-11-10 05:52:54.056023 UTC.
SHA256: `a5897bd2f9dedadbb941b2a0632a4c76d151f47013f875362fbe2908f123f527`.
Metadata and independently extracted rows remain in the read-only review
`040046-metadata.json` / `040046-extracted.json`.

The latest displayed source block is dated **2022-12-08**, with ten overseas
stocks including `PEP` / 百事 / 1.61%. This is evidence of the source's identifier
and report contents, not a claim of current-year holdings. HTTP replay preserves
all ten identifiers, names, weights and dates with unsupported quotes null.
Replacing PEP with PEPX is explicitly a synthetic length control. Additional
single-letter / punctuation-bearing identifiers and concurrent cache reports or
quotes are synthetic boundary controls, not first-party market authenticity
claims. Identifier syntax does not establish an exchange or supported quote.

### #7 calculated estimate identity evidence (2026-11-10 UTC)

`eastmoney/fund-110020.txt` is the verbatim official fund page capture for
`https://fund.eastmoney.com/110020.html`; its page header names request code
110020 and contains the explicit `查看相关ETF` relation to 510310. SHA256:
`d264b1bf3d6ef1f7afe63098568569cf1f876c74ba4942c25f8843dd12ef6278`.
`eastmoney/base-510310.json` is the official Eastmoney base response used as
secondary metadata evidence (SHA256
`2f89813fe06d702905de1dc0c11ce67d3db03a345d090306442541aa6f2afaae`).

`sse/fund-510310.txt` is the verbatim Shanghai Stock Exchange `FUND_LIST`
response for `commonSoaQuery.do` with `fundCode=510310`, `fundType=00`,
`subClass=03`, and listing date 20130325. This is the identity proof used by
core: the official script `sse/fund-type-protocol.txt` maps subClass `03` to
cross-market mainland equity ETF; it is preserved as raw evidence and is not
executed. SHA256 values are respectively
`07ad33267a570ea8c1751020eb1811885ed94262b5ab8621cda5debc5bbdbcf9` and
`ee70d82951b241476dfeceaae265adaccc0a3e059b65459c72c911f15117559c`.
The page capture is fetched evidence only; no page timestamp is used as a
quote timestamp. Synthetic mutations in `estimates-calculated.test.ts` cover
wrong pages, missing/duplicate/external/self links, non-ETF identity, upstream
failure and recovery.
