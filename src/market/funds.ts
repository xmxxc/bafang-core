import { shanghaiDate, type Clock } from '../clock';
import { DailyCache } from './daily-cache';
import { fetchFundBaseInfo, searchFunds } from './eastmoney';
import type { UpstreamFetcher } from './upstream';

export type FundCategory = 'domestic' | 'qdii' | 'etf_feeder';

export interface FundSummary {
  code: string;
  name: string;
  category: FundCategory;
  type: string | null;
}

export interface FundDetail extends FundSummary {
  settlement: {
    tPlusN: number;
    source: 'upstream' | 'category_default';
  };
}

/** 取不到 T+N 时按类别给出的默认值。 */
export const DEFAULT_T_PLUS_N: Record<FundCategory, number> = {
  domestic: 1,
  etf_feeder: 1,
  qdii: 2,
};

/** QDII 优先于 ETF 联接：QDII 的 ETF 联接按 QDII 的确认规则。 */
export function classifyFund(name: string, type: string | null): FundCategory {
  const text = `${name} ${type ?? ''}`;
  if (/QDII/i.test(text) || (type ?? '').includes('海外')) return 'qdii';
  if (name.includes('联接')) return 'etf_feeder';
  return 'domestic';
}

export interface FundService {
  search(keyword: string): Promise<FundSummary[]>;
  get(code: string): Promise<FundDetail | null>;
}

export function createFundService(deps: { upstream: UpstreamFetcher; clock: Clock }): FundService {
  const searchCache = new DailyCache<FundSummary[]>();
  return {
    async search(keyword) {
      const normalized = keyword.trim().toLowerCase();
      const today = shanghaiDate(deps.clock.now());
      const cached = searchCache.get(today, normalized);
      if (cached) return cached;
      const hits = await searchFunds(deps.upstream, normalized);
      const results = hits.map((hit) => ({ ...hit, category: classifyFund(hit.name, hit.type) }));
      searchCache.set(today, normalized, results);
      return results;
    },

    async get(code) {
      const info = await fetchFundBaseInfo(deps.upstream, code);
      if (!info) return null;
      const category = classifyFund(info.name, info.type);
      return {
        code: info.code,
        name: info.name,
        category,
        type: info.type,
        settlement:
          info.confirmDays === null
            ? { tPlusN: DEFAULT_T_PLUS_N[category], source: 'category_default' }
            : { tPlusN: info.confirmDays, source: 'upstream' },
      };
    },
  };
}
