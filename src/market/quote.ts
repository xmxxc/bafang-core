/**
 * 股票与指数行情的统一报价：腾讯、同花顺等适配器都解析成这个形状，再由各业务（大盘指数，
 * 以后的个股行情）决定回退与可信度校验。点位、涨跌额用十进制字符串表示，计算不经过二进制浮点。
 */
export interface Quote {
  /** 最新价或点位，保留 2 位小数。 */
  price: string;
  /** 昨收，保留 2 位小数。 */
  prevClose: string;
  /** 涨跌额 = 最新价 − 昨收，保留 2 位小数。 */
  change: string;
  /** 涨跌幅（百分比）= 涨跌额 ÷ 昨收 × 100，保留 2 位小数。 */
  changePercent: number;
  /** 行情所属交易日（Asia/Shanghai，YYYY-MM-DD；港股与 A 股同在 UTC+8）。 */
  tradeDate: string;
  /** 行情时间。 */
  time: Date;
}

/** 内部定点表示：放大 10^4 的整数。 */
const SCALE = 10_000n;
const DECIMAL = /^-?\d+(\.\d{1,4})?$/;

/** 解析上游给出的十进制字符串；不是合法的、最多 4 位小数的数时返回 null。 */
export function parseDecimal(text: string | undefined | null): bigint | null {
  const value = text?.trim();
  if (!value || !DECIMAL.test(value)) return null;
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  const scaled = BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0'));
  return negative ? -scaled : scaled;
}

/** 整数除法，按「四舍五入、远离零」舍入。 */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = (n * 2n + d) / (d * 2n);
  return negative ? -quotient : quotient;
}

/** 把放大 10^4 的整数格式化为保留 2 位小数的字符串（四舍五入）。 */
function format2(scaled: bigint): string {
  const cents = divRound(scaled, 100n);
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/**
 * 由最新价与昨收算出报价；两者都必须是正数，否则返回 null（视为数据不可信）。
 * 涨跌额与涨跌幅都按全精度计算后再舍入到 2 位小数。
 */
export function buildQuote(
  priceText: string | undefined | null,
  prevCloseText: string | undefined | null,
  tradeDate: string,
  time: Date,
): Quote | null {
  const price = parseDecimal(priceText);
  const prevClose = parseDecimal(prevCloseText);
  if (price === null || prevClose === null || price <= 0n || prevClose <= 0n) return null;
  if (Number.isNaN(time.getTime())) return null;
  const change = price - prevClose;
  const percentHundredths = divRound(change * 10_000n, prevClose);
  return {
    price: format2(price),
    prevClose: format2(prevClose),
    change: format2(change),
    changePercent: Number(percentHundredths) / 100,
    tradeDate,
    time,
  };
}

/** 把上游的 Asia/Shanghai 本地时间（年月日时分秒）转成时间点。 */
export function shanghaiTime(
  year: string,
  month: string,
  day: string,
  hour = '00',
  minute = '00',
  second = '00',
): Date {
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
}
