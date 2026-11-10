import { shanghaiDate, type Clock } from '../clock';
import { DailyCache } from './daily-cache';
import { fetchTencentQuotes } from './tencent';
import { fetchThsQuote } from './ths';
import type { Quote } from './quote';
import { UpstreamError, type UpstreamFetcher } from './upstream';
import type { TradingCalendar } from '../trading-calendar';

export interface TopHolding {
  name: string;
  code: string;
  weight: number | null;
  reportDate: string;
  quote: Quote | null;
  quoteSource: 'tencent' | 'ths' | null;
  quoteFallback: boolean;
}
export interface HoldingsService {
  get(code: string): Promise<{ reportDate: string; items: TopHolding[] } | null>;
}

const EM = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx';
const SINA = 'https://stock.finance.sina.com.cn/fundInfo/api/openapi.php/FdFundService.getTopHold';

export function createHoldingsService(deps: {
  upstream: UpstreamFetcher;
  clock: Clock;
  calendar?: TradingCalendar;
}): HoldingsService {
  const cache = new DailyCache<{
    reportDate: string;
    items: Omit<TopHolding, 'quote' | 'quoteSource' | 'quoteFallback'>[];
  }>();
  return {
    async get(code) {
      const day = shanghaiDate(deps.clock.now());
      const hit = cache.get(day, code);
      let parsed: {
        reportDate: string;
        items: Omit<TopHolding, 'quote' | 'quoteSource' | 'quoteFallback'>[];
      } | null = hit ?? null;
      if (!parsed)
        try {
          parsed = parse(
            await deps.upstream.fetchText({
              url: `${EM}?type=jjcc&code=${code}&topline=10&year=&month=&rt=1`,
              referer: 'https://fundf10.eastmoney.com/',
            }),
          );
        } catch (error) {
          if (!(error instanceof UpstreamError)) throw error;
        }
      if (!parsed) {
        try {
          parsed = parse(
            await deps.upstream.fetchText({
              url: `${SINA}?format=json&symbol=${code}`,
              referer: 'https://finance.sina.com.cn/',
            }),
          );
        } catch (error) {
          if (!(error instanceof UpstreamError)) throw error;
        }
      }
      if (!parsed) throw new UpstreamError('bad_response', 'holdings unavailable');
      cache.set(day, code, parsed);
      const symbols = parsed.items
        .map((i) => symbolFor(i.code))
        .filter((x): x is string => x !== null);
      let primary = new Map<string, Quote | null>();
      try {
        primary = await fetchTencentQuotes(deps.upstream, symbols);
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
      }
      const items = await Promise.all(
        parsed.items.map(async (item) => {
          const symbol = symbolFor(item.code);
          let quote = symbol ? (primary.get(symbol) ?? null) : null;
          if (quote && stale(quote, deps.clock.now(), deps.calendar)) quote = null;
          let source: 'tencent' | 'ths' | null = quote ? 'tencent' : null;
          let fallback = false;
          if (!quote && symbol) {
            try {
              quote = await fetchThsQuote(deps.upstream, thsSymbol(item.code));
              if (quote && stale(quote, deps.clock.now(), deps.calendar)) quote = null;
              source = quote ? 'ths' : null;
              fallback = true;
            } catch (error) {
              if (!(error instanceof UpstreamError)) throw error;
              fallback = true;
            }
          }
          return { ...item, quote, quoteSource: source, quoteFallback: fallback };
        }),
      );
      return { reportDate: parsed.reportDate, items };
    },
  };
}

function symbolFor(code: string): string | null {
  if (!/^\d{6}$/.test(code)) return null;
  if (code.startsWith('6')) return `sh${code}`;
  if (/^[03]/.test(code)) return `sz${code}`;
  return null;
}
function thsSymbol(code: string): string {
  if (code.startsWith('6')) return `hs_${code}`;
  return `sz_${code}`;
}
function clean(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}
export function parse(text: string): {
  reportDate: string;
  items: Omit<TopHolding, 'quote' | 'quoteSource' | 'quoteFallback'>[];
} | null {
  const report =
    text.match(
      /(?:截止|报告期|reportDate|REPORT_DATE|ENDDATE)[^0-9]*(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/,
    ) ||
    text.match(/(20\d{2})[-/](\d{2})[-/](\d{2})/) ||
    text.match(/(?:ENDDATE[^0-9]*)?(20\d{2})(\d{2})(\d{2})/);
  const reportDate = report
    ? `${report[1]}-${String(report[2]).padStart(2, '0')}-${String(report[3]).padStart(2, '0')}`
    : '';
  const items: Omit<TopHolding, 'quote' | 'quoteSource' | 'quoteFallback'>[] = [];
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const value = JSON.parse(json) as Record<string, unknown>;
      const root = (value.result as Record<string, unknown> | undefined) ?? value;
      const data = (root.data as Record<string, unknown> | undefined) ?? root;
      const rows = data.zcpz;
      if (Array.isArray(rows))
        for (const row of rows.slice(0, 10)) {
          const name = String(row.name ?? row.SNAME ?? row.SECURITY_NAME ?? '').trim(),
            code = String(row.code ?? row.SCODE ?? row.SECURITY_CODE ?? '').padStart(6, '0');
          const weight = row.weight ?? row.PCTNV ?? row['占净值比例'];
          if (/^\d{6}$/.test(code) && name)
            items.push({ name, code, weight: parseWeight(weight), reportDate });
        }
    } catch {
      /* ignore malformed optional JSON wrapper */
    }
  }
  for (const row of text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => clean(m[1]!));
    const codeIndex = cells.findIndex((c) => /^\d{6}$/.test(c));
    const code = codeIndex >= 0 ? cells[codeIndex] : undefined;
    const name = codeIndex >= 0 ? cells[codeIndex + 1] : undefined;
    const weight = cells.find((c) => /%/.test(c));
    if (code && name && !items.some((i) => i.code === code))
      items.push({ name, code, weight: parseWeight(weight), reportDate });
  }
  if (!reportDate || items.length === 0) return null;
  return { reportDate, items: items.slice(0, 10).map((i) => ({ ...i, reportDate })) };
}
function parseWeight(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(String(value).replace('%', '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function stale(quote: Quote, now: Date, calendar?: TradingCalendar): boolean {
  const day = shanghaiDate(now);
  if (quote.tradeDate === day) return false;
  if (quote.tradeDate > day) return true;
  if (calendar && !calendar.isTradingDay(now)) return false;
  const wd = new Date(`${day}T00:00:00+08:00`).getDay();
  return wd >= 1 && wd <= 5;
}
