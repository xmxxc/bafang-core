import { shanghaiDate } from '../clock';
import { add, divide, formatFixed, multiply, parseFixed, type Fixed } from '../fixed-point';
import { fetchLinkedEtfCode, fetchVerifiedEtfCode } from './eastmoney';
import type { EstimateServiceDeps } from './estimates';
import type { SourceEstimate } from './estimate-sources';
import { stale } from './holdings';
import { fetchTencentQuotes } from './tencent';
import { fetchThsIntraday, type ThsIntradayPoint } from './ths';
import { fetchThsQuote } from './ths';
import type { Quote } from './quote';
import { formatNav } from './estimate-sources';
import { UpstreamError } from './upstream';

export interface Calculation {
  method: 'top_holdings' | 'parent_etf';
  reportDate: string | null;
  disclosedWeightPercent: number;
  parentEtfCode: string | null;
  quoteTimeEnd: string | null;
  quoteSource?: 'tencent' | 'ths' | 'mixed';
}
export interface CalculatedSource extends SourceEstimate {
  calculation: Calculation;
}
export interface IntradayEstimate {
  code: string;
  tradeDate: string;
  status: 'estimated' | 'unavailable' | 'pre_market' | 'holiday';
  source: 'calculated';
  referenceOnly: true;
  fallback: true;
  calculation: Calculation | null;
  points: { time: string; changePercent: number; value: string }[];
  coverage: { returnedPoints: number; omittedPoints: number };
}
interface Component {
  symbol: string;
  weight: Fixed;
  quote?: Quote;
  quoteSource?: 'tencent' | 'ths';
}
const hundred = { value: 100n, scale: 0 };
const one = { value: 1n, scale: 0 };

// All arithmetic stays fixed point until the final JSON percentage conversion.
function calculatedPoint(baseNav: string, components: { weight: Fixed; changePercent: number }[]) {
  const base = parseFixed(baseNav, 4);
  if (!base || base.value <= 0n) return null;
  let change: Fixed = { value: 0n, scale: 8 };
  for (const component of components) {
    const rate = parseFixed(String(component.changePercent), 4);
    if (!rate) return null;
    change = add(change, divide(multiply(component.weight, rate, 8), hundred, 8));
  }
  const factor = add(one, divide(change, hundred, 10));
  const value = multiply(base, factor, 4);
  if (value.value <= 0n) return null;
  return { changePercent: Number(formatFixed(change)), value: formatFixed(value) };
}

export function createCalculatedEstimates(deps: EstimateServiceDeps) {
  // Successful relationships are refreshed after one hour, and never across Shanghai dates.
  // Failures are not cached, so a recovered upstream can be used immediately.
  const mappings = new Map<string, { code: string; at: number; day: string }>();
  async function components(code: string, asOf: Date) {
    const fund = await deps.funds.get(code);
    if (
      !fund ||
      fund.category === 'qdii' ||
      !/^(股票型|混合型|债券型|指数型|货币型|FOF)(?:-|$)/i.test(fund.type ?? '')
    )
      return null;
    if (fund.category === 'etf_feeder') {
      let entry = mappings.get(code);
      if (
        !entry ||
        entry.day !== shanghaiDate(asOf) ||
        entry.at > asOf.getTime() ||
        asOf.getTime() - entry.at >= 3600_000
      ) {
        const parent = await fetchLinkedEtfCode(deps.upstream, code);
        if (!parent || !(await fetchVerifiedEtfCode(deps.upstream, parent, asOf))) return null;
        // The fund page relationship is adopted only after the exchange confirms the ETF.
        // The exchange lists (SSE/SZSE) are not health-reported upstreams.
        deps.upstream.recordSuccess?.('eastmoney');
        entry = { code: parent, at: asOf.getTime(), day: shanghaiDate(asOf) };
        if (mappings.size >= 5000) mappings.delete(mappings.keys().next().value!);
        mappings.set(code, entry);
      }
      // Only a verified exchange mapping can select this prefix. Unknown markets fail closed.
      const symbol = /^5\d{5}$/.test(entry.code)
        ? `sh${entry.code}`
        : /^1\d{5}$/.test(entry.code)
          ? `sz${entry.code}`
          : null;
      if (!symbol) return null;
      return {
        items: [{ symbol, weight: hundred }] as Component[],
        method: 'parent_etf' as const,
        reportDate: null,
        disclosedWeightPercent: 100,
        parentEtfCode: entry.code,
      };
    }
    const report = await deps.holdings.get(code, asOf);
    // Only a list proven to be the complete disclosure can back the model. The Sina fallback
    // lists A shares only, so disclosed holdings it omits would wrongly count as undisclosed.
    if (
      !report ||
      report.holdingsSource !== 'eastmoney' ||
      !validReport(report.reportDate, asOf) ||
      !report.items.length
    )
      return null;
    const items: Component[] = [];
    let total = { value: 0n, scale: 4 };
    for (const item of report.items) {
      const weight = parseFixed(String(item.weight), 4);
      const symbol = /^6\d{5}$/.test(item.code)
        ? `sh${item.code}`
        : /^[03]\d{5}$/.test(item.code)
          ? `sz${item.code}`
          : null;
      if (!weight || weight.value < 0n || !symbol || item.reportDate !== report.reportDate)
        return null;
      total = add(total, weight);
      items.push({
        symbol,
        weight,
        quote: item.quote ?? undefined,
        quoteSource: item.quoteSource ?? undefined,
      });
    }
    if (total.value > 1000000n) return null;
    return {
      items,
      method: 'top_holdings' as const,
      reportDate: report.reportDate,
      disclosedWeightPercent: Number(formatFixed(total)),
      parentEtfCode: null,
    };
  }
  return {
    async current(code: string, asOf: Date): Promise<CalculatedSource | null> {
      const model = await components(code, asOf);
      if (!model) return null;
      const base = await deps.nav.latestBefore(code, shanghaiDate(asOf), asOf);
      if (!base) return null;
      if (model.method === 'parent_etf') {
        let quotes = new Map<string, Quote | null>();
        try {
          quotes = await fetchTencentQuotes(
            deps.upstream,
            model.items.map((item) => item.symbol),
          );
        } catch (error) {
          if (!(error instanceof UpstreamError)) throw error;
          console.warn(
            '[bafang-core] parent ETF Tencent quote failed',
            code,
            error.kind,
            error.message,
          );
        }
        // Like holding quotes, a snapshot is judged when it is observed, not at the request start.
        const observedAt = deps.clock.now();
        for (const item of model.items) {
          let quote = quotes.get(item.symbol) ?? null;
          if (quote && stale(quote, observedAt, deps.calendar)) quote = null;
          if (quote) deps.upstream.recordSuccess?.('tencent');
          const quoteSource: 'tencent' | 'ths' = quote ? 'tencent' : 'ths';
          if (!quote) {
            quote = await fetchThsQuote(
              deps.upstream,
              item.symbol.startsWith('sh')
                ? `hs_${item.symbol.slice(2)}`
                : `sz_${item.symbol.slice(2)}`,
            );
            // The backup snapshot is judged when its own call returns.
            if (quote && stale(quote, deps.clock.now(), deps.calendar)) quote = null;
            if (quote) deps.upstream.recordSuccess?.('ths');
          }
          item.quote = quote ?? undefined;
          item.quoteSource = quote ? quoteSource : undefined;
        }
      }
      // Recheck every participating quote once all are in: none may be later than this moment,
      // and each must still satisfy the session and freshness rules now.
      const doneAt = deps.clock.now();
      if (
        model.items.some(
          (item) =>
            !item.quote ||
            stale(item.quote, doneAt, deps.calendar) ||
            item.quote.tradeDate !== shanghaiDate(doneAt),
        )
      )
        return null;
      const times = model.items.map((item) => item.quote!.time.getTime());
      const first = Math.min(...times),
        last = Math.max(...times);
      if (last - first > 300000) return null;
      const point = calculatedPoint(
        base.unitNav,
        model.items.map((item) => ({
          weight: item.weight,
          changePercent: item.quote!.changePercent,
        })),
      );
      if (!point) return null;
      const quoteSources = new Set(model.items.map((item) => item.quoteSource).filter(Boolean));
      return {
        ...point,
        time: new Date(first),
        base: { date: base.date, unitNav: formatNav(base.unitNav)! },
        calculation: {
          method: model.method,
          reportDate: model.reportDate,
          disclosedWeightPercent: model.disclosedWeightPercent,
          parentEtfCode: model.parentEtfCode,
          quoteTimeEnd: new Date(last).toISOString(),
          quoteSource:
            quoteSources.size === 1
              ? [...quoteSources][0]
              : quoteSources.size > 1
                ? 'mixed'
                : undefined,
        },
      };
    },
    async intraday(code: string, asOf: Date): Promise<IntradayEstimate> {
      const result: IntradayEstimate = {
        code,
        tradeDate: shanghaiDate(asOf),
        status: 'unavailable',
        source: 'calculated',
        referenceOnly: true,
        fallback: true,
        calculation: null,
        points: [],
        coverage: { returnedPoints: 0, omittedPoints: 0 },
      };
      const model = await components(code, asOf);
      if (!model) return result;
      const base = await deps.nav.latestBefore(code, result.tradeDate, asOf);
      if (!base) return result;
      // Each series is judged at the moment it was observed: its own labels may not be later
      // than that moment, and it must still be the request's Shanghai day. Another, slower
      // series never extends this bound.
      const observed = await Promise.all(
        model.items.map(async (item) => {
          const symbol = item.symbol.replace(/^sh/, 'hs_').replace(/^sz/, 'sz_');
          const points = await fetchThsIntraday(deps.upstream, symbol);
          const observedAt = deps.clock.now();
          if (shanghaiDate(observedAt) !== result.tradeDate) return null;
          const usable = new Map(
            points
              .filter(
                (point) =>
                  point.time <= observedAt && shanghaiDate(point.time) === result.tradeDate,
              )
              .map((point) => [point.time.getTime(), point]),
          );
          // An empty series (before the first trade) is a legal empty result, not a success.
          if (usable.size > 0) deps.upstream.recordSuccess?.('ths');
          return usable;
        }),
      );
      // A series observed after the Shanghai date changed belongs to a previous day: no points,
      // and the old day's NAV base is not re-applied to it.
      const series = observed.filter(
        (points): points is Map<number, ThsIntradayPoint> => points !== null,
      );
      if (series.length !== observed.length) return result;
      const labels = new Set(series.flatMap((points) => [...points.keys()]));
      for (const at of [...labels].sort((a, b) => a - b)) {
        if (!series.every((points) => points.has(at))) {
          result.coverage.omittedPoints++;
          continue;
        }
        const point = calculatedPoint(
          base.unitNav,
          model.items.map((item, index) => ({
            weight: item.weight,
            changePercent: series[index]!.get(at)!.changePercent,
          })),
        );
        if (point) result.points.push({ time: new Date(at).toISOString(), ...point });
        else result.coverage.omittedPoints++;
      }
      result.coverage.returnedPoints = result.points.length;
      result.status = result.points.length ? 'estimated' : 'unavailable';
      result.calculation = {
        method: model.method,
        reportDate: model.reportDate,
        disclosedWeightPercent: model.disclosedWeightPercent,
        parentEtfCode: model.parentEtfCode,
        quoteTimeEnd: result.points.at(-1)?.time ?? null,
      };
      return result;
    },
  };
}
function validReport(date: string, asOf: Date) {
  // A completed quarter-end within the last six months; older disclosures cannot establish current exposure.
  if (!/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(date)) return false;
  const at = new Date(`${date}T00:00:00+08:00`);
  return at < asOf && asOf.getTime() - at.getTime() <= 184 * 86400000;
}
