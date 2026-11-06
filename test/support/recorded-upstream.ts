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
};

/** 所有上游请求都失败（默认是超时）。 */
export function upstreamDown(error = new UpstreamError('timeout', 'recorded timeout')): Replay {
  return () => error;
}
