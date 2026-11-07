import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UpstreamError,
  type UpstreamFetcher,
  type UpstreamRequest,
} from '../../src/market/upstream';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/upstream');

/** 读取一份录制的上游响应体。 */
export function sample(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

function exists(name: string): boolean {
  return existsSync(path.join(FIXTURES, name));
}

/** 对一个上游请求的回放：返回响应体文本，或抛出给定的上游错误。 */
export type Replay = (url: URL) => string | UpstreamError;

/**
 * 统一上游抓取适配器的替身：整体替换真实适配器，按请求回放录制样本。
 * 没有 Referer 的请求按上游的防盗链行为拒绝（403）；
 * 回放函数未覆盖的请求视为测试编写错误，直接抛出普通异常。
 */
export class RecordedUpstream implements UpstreamFetcher {
  constructor(private replay: Replay) {}

  /** 换一套回放，例如让之后的上游请求全部失败。 */
  use(replay: Replay): void {
    this.replay = replay;
  }

  async fetchText(request: UpstreamRequest): Promise<string> {
    if (!request.referer) {
      throw new UpstreamError('http_status', 'missing Referer', 403);
    }
    const result = this.replay(new URL(request.url));
    if (result instanceof UpstreamError) throw result;
    return result;
  }
}

const SEARCH_SAMPLES: Record<string, string> = {
  '000001': 'eastmoney/search-000001.json',
  华夏成长: 'eastmoney/search-name-huaxiachengzhang.json',
  hxcz: 'eastmoney/search-pinyin-hxcz.json',
  zzzzqqqxx: 'eastmoney/search-only-stocks-zzzzqqqxx.json',
  '~~': 'eastmoney/search-empty.json',
};

const BASE_INFO_SAMPLES: Record<string, string> = {
  '000001': 'eastmoney/base-000001.json',
  '040046': 'eastmoney/base-040046.json',
  '110020': 'eastmoney/base-110020.json',
  '999999': 'eastmoney/base-999999.json',
};

/** 东方财富的录制样本：基金搜索、基金基础信息与净值。 */
export const eastmoneySamples: Replay = (url) => {
  if (url.hostname === 'fundsuggest.eastmoney.com') {
    const file = SEARCH_SAMPLES[url.searchParams.get('key') ?? ''];
    if (file) return sample(file);
  }
  if (url.hostname === 'fundmobapi.eastmoney.com') {
    const file = BASE_INFO_SAMPLES[url.searchParams.get('FCODE') ?? ''];
    if (file) return sample(file);
  }
  if (url.hostname === 'api.fund.eastmoney.com') {
    const code = url.searchParams.get('fundCode') ?? '';
    const pageSize = url.searchParams.get('pageSize');
    const pageIndex = url.searchParams.get('pageIndex') ?? '1';
    if (pageSize === '1') {
      const file = NAV_LATEST_SAMPLES[code];
      if (file) return sample(file);
    }
    if (pageSize === '20') {
      const startDate = url.searchParams.get('startDate') ?? '';
      const file = `eastmoney/nav-${code}-history-${startDate}-p${pageIndex}.json`;
      if (exists(file)) return sample(file);
    }
  }
  throw new Error(`no recorded sample for ${url.href}`);
};

const NAV_LATEST_SAMPLES: Record<string, string> = {
  '000001': 'eastmoney/nav-000001-latest.json',
  '999999': 'eastmoney/nav-999999-latest.json',
  '040046': 'eastmoney/nav-040046-latest-2026-11-06.json',
  '110020': 'eastmoney/nav-110020-latest-2026-11-06.json',
};

/** 所有上游请求都失败（默认是超时）。 */
export function upstreamDown(error = new UpstreamError('timeout', 'recorded timeout')): Replay {
  return () => error;
}

const TIANTIAN_SAMPLE = 'tiantian/valuation-000001-110020-040046-999999.json';
const SINA_SAMPLE = 'sina/fu-000001-110020-040046-999999.txt';

/**
 * 天天基金批量估值的回放：从录制样本里只留下请求的 FCODES，和真实上游一样，
 * 没有估值数据的代码（如不存在的基金）不出现在 data 里。可传入改写过的响应体。
 */
export function tiantianSamples(body: string = sample(TIANTIAN_SAMPLE)): Replay {
  return (url) => {
    if (url.hostname !== 'fundcomapi.tiantianfunds.com') {
      throw new Error(`no recorded sample for ${url.href}`);
    }
    const wanted = new Set((url.searchParams.get('FCODES') ?? '').split(','));
    const parsed = JSON.parse(body) as { data?: { FCODE: string }[] | null };
    if (!Array.isArray(parsed.data)) return body;
    return JSON.stringify({ ...parsed, data: parsed.data.filter((row) => wanted.has(row.FCODE)) });
  };
}

/**
 * 新浪 `fu_` 估值的回放：按 list= 里的顺序逐只返回录制行；录制里没有的代码返回空串，
 * 和真实上游对不存在的基金一样。样本已从 GBK 转成 UTF-8（替身位于解码之后）。
 */
export function sinaSamples(body: string = sample(SINA_SAMPLE)): Replay {
  return (url) => {
    if (url.hostname !== 'hq.sinajs.cn') {
      throw new Error(`no recorded sample for ${url.href}`);
    }
    const lines = new Map<string, string>();
    for (const match of body.matchAll(/var hq_str_fu_(\d{6})="([^"]*)";/g)) {
      lines.set(match[1]!, match[2]!);
    }
    // 新浪的写法是 `https://hq.sinajs.cn/list=fu_000001,fu_110020`，代码列表在路径里。
    const list = /^\/list=(.*)$/.exec(url.pathname)?.[1];
    if (list === undefined) throw new Error(`no recorded sample for ${url.href}`);
    return list
      .split(',')
      .map((symbol) => `var hq_str_${symbol}="${lines.get(symbol.replace(/^fu_/, '')) ?? ''}";`)
      .join('\n');
  };
}

/** 按主机把请求分给不同的回放；没有对应回放的主机视为测试编写错误。 */
export function byHost(replays: Record<string, Replay>): Replay {
  return (url) => {
    const replay = replays[url.hostname];
    if (!replay) throw new Error(`no recorded sample for ${url.href}`);
    return replay(url);
  };
}

/** 估值两级来源，以及核对估值基准用的东方财富净值，都按录制样本回放。 */
export function estimateSamples(
  overrides: { tiantian?: Replay; sina?: Replay; nav?: Replay } = {},
): Replay {
  return byHost({
    'fundcomapi.tiantianfunds.com': overrides.tiantian ?? tiantianSamples(),
    'hq.sinajs.cn': overrides.sina ?? sinaSamples(),
    'api.fund.eastmoney.com': overrides.nav ?? eastmoneySamples,
  });
}
