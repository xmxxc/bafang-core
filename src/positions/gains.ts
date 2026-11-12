import { shanghaiDate, type Clock } from '../clock';
import type { EstimateService, EstimateSource } from '../market/estimates';
import type { NavService } from '../market/nav';
import type { TradingCalendar } from '../trading-calendar';
import {
  add,
  divide,
  fixedFromDb,
  formatFixed,
  multiply,
  parseFixed,
  rescale,
  subtract,
} from '../fixed-point';
import type { PositionValuation } from './service';

export interface PositionGains {
  todayGain: string | null;
  todayGainRate: string | null;
  todayGainStatus: 'estimated' | 'confirmed' | 'unavailable';
  todayGainDate: string;
  /** 份额 × 上一净值，保留乘积的全部 8 位小数，避免小额分母提前舍入成 0。 */
  previousMarketValue: string | null;
  totalGain: string | null;
}

/** 今日收益实际使用的行情；净值只有日期精度，不虚构发布时间。 */
export interface PositionQuote {
  type: 'estimate' | 'nav' | 'unavailable';
  direction: 'up' | 'down' | 'flat' | null;
  value: string | null;
  changePercent: number | null;
  date: string | null;
  time: string | null;
  source: EstimateSource | 'eastmoney' | null;
  sourceName: string | null;
  fallback: boolean;
}

export type QuotedPosition = PositionValuation & PositionGains & { quote: PositionQuote };

/** 在读取时计算收益；同一批次同一基金共用行情，跨渠道使用同一份基准与估值。 */
export function createPositionGains(deps: {
  nav: NavService;
  estimates: EstimateService;
  clock: Clock;
  calendar: TradingCalendar;
}) {
  return async (items: PositionValuation[], asOf?: Date): Promise<QuotedPosition[]> => {
    const now = asOf ?? deps.clock.now();
    const today = shanghaiDate(now);
    const tradingDay = deps.calendar.isTradingDay(now);
    const codes = [...new Set(items.map((item) => item.fundCode))];
    const previous = new Map(
      await Promise.all(
        codes.map(
          async (code) =>
            [
              code,
              tradingDay ? await deps.nav.latestBefore(code, today, now).catch(() => null) : null,
            ] as const,
        ),
      ),
    );
    const unconfirmed = [
      ...new Set(
        items
          .filter((item) => item.navDate !== today && previous.get(item.fundCode))
          .map((item) => item.fundCode),
      ),
    ];
    const batch =
      tradingDay && unconfirmed.length > 0 ? await deps.estimates.batch(unconfirmed, now) : null;
    const estimates = new Map(batch?.items.map((item) => [item.code, item.estimate]));
    return items.map((item) => {
      const baseNav = previous.get(item.fundCode);
      const prior = baseNav ? parseFixed(baseNav.unitNav, 4, { round: true }) : null;
      const shares = fixedFromDb(item.shares, 4);
      const denominator = prior ? multiply(shares, prior, 8) : null;
      let gain = null;
      let status: PositionGains['todayGainStatus'] = 'unavailable';
      let quote: PositionQuote = {
        type: 'unavailable',
        direction: null,
        value: null,
        changePercent: null,
        date: null,
        time: null,
        source: null,
        sourceName: null,
        fallback: false,
      };
      if (denominator && prior && tradingDay) {
        if (item.navDate === today && item.nav !== null) {
          const change = subtract(fixedFromDb(item.nav, 4), prior);
          gain = multiply(shares, change, 2);
          status = 'confirmed';
          const rate = prior.value === 0n ? null : divide(change, prior, 4);
          quote = {
            type: 'nav',
            direction: changeDirection(change.value),
            value: item.nav,
            changePercent: rate ? Number(formatFixed({ value: rate.value, scale: 2 })) : null,
            date: today,
            time: today,
            source: 'eastmoney',
            sourceName: '东方财富',
            fallback: false,
          };
        } else {
          const estimate = estimates.get(item.fundCode);
          // 行情接口的百分数转为十进制文本，按 6 位百分数定点舍入；除以 100 只调整 scale。
          const percent = estimate ? estimatePercent(estimate.changePercent) : null;
          if (estimate && percent) {
            gain = multiply(denominator, { value: percent.value, scale: percent.scale + 2 }, 2);
            status = 'estimated';
            quote = {
              type: 'estimate',
              direction: changeDirection(estimate.changePercent),
              value: estimate.value,
              changePercent: estimate.changePercent,
              date: today,
              time: estimate.time,
              source: estimate.source,
              sourceName: estimate.sourceName,
              fallback: estimate.fallback,
            };
          }
        }
      }
      return {
        ...item,
        quote,
        todayGain: gain ? formatFixed(gain) : null,
        todayGainRate:
          gain && denominator && denominator.value !== 0n
            ? formatFixed(divide(gain, denominator, 4))
            : null,
        todayGainStatus: status,
        todayGainDate: today,
        previousMarketValue: denominator ? formatFixed(denominator) : null,
        totalGain:
          item.holdingGain === null
            ? null
            : formatFixed(add(fixedFromDb(item.holdingGain, 2), fixedFromDb(item.realizedGain, 2))),
      };
    });
  };
}

function changeDirection(change: bigint | number): 'up' | 'down' | 'flat' {
  return change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
}

/** 有限行情百分数的文本可能是指数形式；只在 scale 上应用指数，再由定点模块舍入。 */
function estimatePercent(value: number) {
  const [mantissa = '', exponent = '0'] = String(value).split('e');
  const scale = mantissa.split('.')[1]?.length ?? 0;
  const parsed = parseFixed(mantissa, scale);
  return parsed
    ? rescale({ value: parsed.value, scale: parsed.scale - Number(exponent) }, 6)
    : null;
}
