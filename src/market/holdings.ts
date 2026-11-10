import { shanghaiDate, shanghaiMinutesOfDay, type Clock } from '../clock';
import { DailyCache } from './daily-cache';
import { fetchTencentQuotes } from './tencent';
import { fetchThsQuote } from './ths';
import type { Quote } from './quote';
import { UpstreamError, type UpstreamFetcher } from './upstream';
import type { TradingCalendar } from '../trading-calendar';

export interface TopHolding {
  name: string;
  code: string;
  weight: number;
  reportDate: string;
  quote: Quote | null;
  quoteSource: 'tencent' | 'ths' | null;
  quoteFallback: boolean;
}
type Report = {
  reportDate: string;
  items: Omit<TopHolding, 'quote' | 'quoteSource' | 'quoteFallback'>[];
};
export interface HoldingsService {
  get(code: string): Promise<{ reportDate: string; items: TopHolding[] } | null>;
}

type ResolvedQuote = Pick<TopHolding, 'quote' | 'quoteSource' | 'quoteFallback'>;

const EM = 'https://fundf10.eastmoney.com/FundArchivesDatas.aspx';

export function createHoldingsService(deps: {
  upstream: UpstreamFetcher;
  clock: Clock;
  calendar: TradingCalendar;
}): HoldingsService {
  const cache = new DailyCache<Report>();
  let cachedReportDay: string | undefined;
  const quotes = new Map<
    string,
    { value: ResolvedQuote; expiresAt: number; sampledAt: number; requestId: number }
  >();
  let lastRequestId = 0;
  return {
    async get(code) {
      const requestId = ++lastRequestId;
      const asOf = deps.clock.now();
      const day = shanghaiDate(asOf);
      let parsed: Report | null | undefined = cache.get(day, code);
      if (!parsed) {
        try {
          parsed = parseEastmoney(
            await deps.upstream.fetchText({
              url: `${EM}?type=jjcc&code=${code}&topline=10&year=&month=&rt=1`,
              referer: 'https://fundf10.eastmoney.com/',
            }),
          );
          // Only a recognized, successful empty report proves absence of a report.
          if (!parsed) return null;
        } catch (error) {
          if (!(error instanceof UpstreamError)) throw error;
          console.warn('[bafang-core] eastmoney holdings failed', error.kind, error.message);
          try {
            parsed = parseSina(
              await deps.upstream.fetchText({
                url: `https://finance.sina.com.cn/fund/quotes/${code}/bc.shtml`,
                referer: 'https://finance.sina.com.cn/',
                encoding: 'utf-8',
              }),
            );
          } catch (backupError) {
            if (!(backupError instanceof UpstreamError)) throw backupError;
            console.warn(
              '[bafang-core] sina holdings failed',
              backupError.kind,
              backupError.message,
            );
            throw backupError;
          }
        }
        // A response from yesterday may finish after today's reports have been cached.
        if (!cachedReportDay || day >= cachedReportDay) {
          cache.set(day, code, parsed);
          cachedReportDay = day;
        }
      }
      const symbols = parsed.items
        .map((i) => symbolFor(i.code))
        .filter((x): x is string => x !== null);
      // Capture eligible entries before any await: another request may advance the cache.
      const hits = new Map(
        symbols.flatMap((symbol) => {
          const entry = quotes.get(symbol);
          return entry && entry.sampledAt <= asOf.getTime() && entry.expiresAt > asOf.getTime()
            ? [[symbol, entry.value] as const]
            : [];
        }),
      );
      const pending = symbols.filter((symbol) => !hits.has(symbol));
      let primary = new Map<string, Quote | null>();
      if (pending.length > 0) {
        try {
          primary = await fetchTencentQuotes(deps.upstream, pending);
        } catch (error) {
          if (!(error instanceof UpstreamError)) throw error;
          console.warn('[bafang-core] tencent holdings quotes failed', error.kind, error.message);
        }
      }
      const items = await Promise.all(
        parsed.items.map(async (item) => {
          const symbol = symbolFor(item.code);
          const hit = symbol ? hits.get(symbol) : undefined;
          if (hit) return { ...item, ...hit };
          let quote = symbol ? (primary.get(symbol) ?? null) : null;
          if (quote && stale(quote, asOf, deps.calendar)) quote = null;
          let source: 'tencent' | 'ths' | null = quote ? 'tencent' : null;
          const fallback = !quote && symbol !== null;
          if (fallback) {
            try {
              quote = await fetchThsQuote(
                deps.upstream,
                symbol!.startsWith('sh') ? `hs_${item.code}` : `sz_${item.code}`,
              );
              if (quote && stale(quote, asOf, deps.calendar)) quote = null;
              source = quote ? 'ths' : null;
            } catch (error) {
              if (!(error instanceof UpstreamError)) throw error;
              console.warn(
                '[bafang-core] ths holding quote failed',
                item.code,
                error.kind,
                error.message,
              );
            }
          }
          const value = { quote, quoteSource: source, quoteFallback: fallback };
          if (symbol) {
            const existing = quotes.get(symbol);
            const previousQuote = existing?.value.quote;
            // Prefer the newer market snapshot. Equal timestamps (or unavailable results)
            // use request order to break millisecond ties, independent of completion order.
            const newer =
              quote && previousQuote && quote.time.getTime() !== previousQuote.time.getTime()
                ? quote.time.getTime() > previousQuote.time.getTime()
                : !existing ||
                  asOf.getTime() > existing.sampledAt ||
                  (asOf.getTime() === existing.sampledAt && requestId > existing.requestId);
            if (newer)
              quotes.set(symbol, {
                value,
                expiresAt: quoteExpiry(asOf, deps.calendar, quote),
                sampledAt: asOf.getTime(),
                requestId,
              });
          }
          return { ...item, ...value };
        }),
      );
      return { reportDate: parsed.reportDate, items };
    },
  };
}

// Only unambiguous six-digit Shanghai/Shenzhen equity identifiers are quoted.
function symbolFor(code: string): string | null {
  if (/^6\d{5}$/.test(code)) return `sh${code}`;
  if (/^[03]\d{5}$/.test(code)) return `sz${code}`;
  return null;
}
function bad(message: string): never {
  throw new UpstreamError('bad_response', message);
}
function clean(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}
function validDate(value: string): string {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) bad('holdings report date missing');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    bad('invalid holdings report date');
  return value;
}
function holding(
  code: string,
  name: string,
  rawWeight: string,
  reportDate: string,
): Report['items'][number] {
  if (!/^(?!0+$)[A-Za-z0-9][A-Za-z0-9.-]*$/.test(code) || !name) bad('invalid holding identifier');
  if (!/^\d+(?:\.\d+)?%$/.test(rawWeight)) bad('holding weight missing or invalid');
  const weight = Number(rawWeight.slice(0, -1));
  if (!Number.isFinite(weight) || weight > 100) bad('holding weight out of range');
  return { code, name, weight, reportDate };
}
function report(reportDate: string, items: Report['items']): Report {
  if (!items.length || new Set(items.map((item) => item.code)).size !== items.length)
    bad('holdings rows empty or duplicated');
  return { reportDate, items: items.slice(0, 10) };
}
function parseEastmoney(text: string): Report | null {
  // Decode the string without executing upstream JavaScript. Arbitrary HTML is not this protocol.
  const match =
    /^\s*var\s+apidata\s*=\s*\{\s*content\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*arryear\s*:\s*\[([\d,\s]*)\]\s*,\s*curyear\s*:\s*\d+\s*\}\s*;?\s*$/.exec(
      text,
    );
  if (!match) bad('eastmoney holdings script invalid');
  let html: string;
  try {
    html = JSON.parse(match[1]!) as string;
  } catch {
    bad('eastmoney holdings content invalid');
  }
  if (!html.trim() && !match[2]!.trim()) return null;
  const blocks = [
    ...html.matchAll(
      /<h4\b[^>]*>[\s\S]*?截止至[^<]*<font\b[^>]*>([^<]+)<\/font>[\s\S]*?<\/h4>[\s\S]*?<table\b[^>]*>([\s\S]*?)<\/table>/gi,
    ),
  ];
  if (!blocks.length) bad('eastmoney holdings quarter missing');
  const dated = blocks.map((block) => ({ date: validDate(block[1]!.trim()), html: block[2]! }));
  const latest = dated.sort((a, b) => b.date.localeCompare(a.date))[0]!;
  if (!/股票代码/.test(latest.html) || !/股票名称/.test(latest.html) || !/占净值/.test(latest.html))
    bad('eastmoney holdings columns invalid');
  const items: Report['items'] = [];
  for (const row of latest.html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => clean(m[1]!));
    if (!cells.length) continue;
    // The F10 stock table has rank, code, name, quote, change, links, allocation.
    items.push(holding(cells[1] ?? '', cells[2] ?? '', cells[6] ?? '', latest.date));
  }
  return report(latest.date, items);
}
function parseSina(text: string): Report {
  const section = /<div\b[^>]*\bid=["']sdzc_blk["'][^>]*>([\s\S]*?<\/table>)/i.exec(text)?.[1];
  if (!section) bad('sina holdings section missing');
  const date = validDate(
    /数据日期：\s*<span[^>]*>([^<]+)<\/span>/i.exec(section)?.[1]?.trim() ?? '',
  );
  const table =
    /<table\b[^>]*\bid=["']fund_sdzc_table["'][^>]*\bcodelist=["']([^"']*)["'][^>]*>([\s\S]*?)<\/table>/i.exec(
      section,
    );
  if (!table || !/股票简称/.test(table[2]!) || !/占净值比例/.test(table[2]!))
    bad('sina holdings table invalid');
  const symbols = table[1]!.split(',');
  const body = /<tbody>([\s\S]*?)<\/tbody>/i.exec(table[2]!)?.[1];
  if (!body) bad('sina holdings rows missing');
  const items: Report['items'] = [];
  for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => clean(m[1]!));
    const symbol = /\/realstock\/company\/([A-Za-z0-9]+)\/nc.shtml/.exec(row[1]!)?.[1];
    if (!symbol || symbol !== symbols[items.length]) bad('sina holdings code list mismatch');
    items.push(holding(symbol.replace(/^(?:sh|sz|hk)/, ''), cells[0] ?? '', cells[3] ?? '', date));
  }
  if (items.length !== symbols.length || items.length > 10) bad('sina holdings incomplete table');
  return report(date, items);
}

function stale(quote: Quote, asOf: Date, calendar: TradingCalendar): boolean {
  const day = shanghaiDate(asOf);
  const minute = shanghaiMinutesOfDay(asOf);
  const trading = calendar.isTradingDay(asOf);
  let expectedDay = day;
  const needsClose = !trading || minute < 570 || minute >= 900;
  if (!trading || minute < 570) {
    let previous = new Date(`${day}T12:00:00+08:00`);
    let found = false;
    for (let i = 0; i < 31; i++) {
      previous = new Date(previous.getTime() - 86400_000);
      if (calendar.isTradingDay(previous)) {
        expectedDay = shanghaiDate(previous);
        found = true;
        break;
      }
    }
    if (!found) return true;
  }
  const time = quote.time.getTime();
  if (
    !Number.isFinite(time) ||
    quote.tradeDate !== expectedDay ||
    shanghaiDate(quote.time) !== expectedDay ||
    time > asOf.getTime()
  )
    return true;
  const quoteMinute = shanghaiMinutesOfDay(quote.time);
  // Providers timestamp snapshots as well as trades: a post-15:00 snapshot is a close,
  // but an earlier snapshot cannot establish the closing price.
  if (needsClose) return quoteMinute < 900;
  if (quoteMinute < 570 || quoteMinute > 900) return true;
  // Operational freshness budget: 5 minutes while trading. During lunch retain
  // the morning close (11:25 or newer); Tencent also timestamps snapshots in lunch.
  const target =
    minute >= 690 && minute < 780 ? new Date(`${day}T11:30:00+08:00`).getTime() : asOf.getTime();
  return target - time > 5 * 60_000;
}

// Match the market module's TTLs; a session or date boundary always invalidates a snapshot.
function quoteExpiry(asOf: Date, calendar: TradingCalendar, quote: Quote | null): number {
  const minute = shanghaiMinutesOfDay(asOf);
  const tradingDay = calendar.isTradingDay(asOf);
  const ttl = !quote
    ? 10_000
    : !tradingDay || minute >= 900
      ? 300_000
      : minute < 570
        ? 30_000
        : 10_000;
  const boundary = tradingDay ? [570, 690, 780, 900, 1440].find((at) => at > minute)! : 1440;
  const midnight = new Date(`${shanghaiDate(asOf)}T00:00:00+08:00`).getTime();
  const active = tradingDay && ((minute >= 570 && minute < 690) || (minute >= 780 && minute < 900));
  const freshness = active && quote ? quote.time.getTime() + 5 * 60_000 + 1 : Infinity;
  return Math.min(asOf.getTime() + ttl, midnight + boundary * 60_000, freshness);
}
