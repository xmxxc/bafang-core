/**
 * 持仓用的定点小数：值是放大 10^scale 的 bigint，计算全程不经过二进制浮点。
 * 舍入与 `src/market/quote.ts` 一致：四舍五入、远离零。
 */
export type Fixed = { value: bigint; scale: number };

const POW10 = (n: number) => 10n ** BigInt(n);
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** 整数除法，按「四舍五入、远离零」舍入。 */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('除数不能为零');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = (n * 2n + d) / (d * 2n);
  return negative ? -quotient : quotient;
}

/** 把定点数换到另一精度；降精度时四舍五入。 */
export function rescale(value: Fixed, scale: number): Fixed {
  if (scale >= value.scale) return { value: value.value * POW10(scale - value.scale), scale };
  return { value: divRound(value.value, POW10(value.scale - scale)), scale };
}

/**
 * 解析十进制字符串。默认小数位超过 scale 时返回 null（用户输入不替用户舍入）；
 * `round: true` 时按四舍五入降到 scale（用于上游净值等外部数据）。不是合法十进制数时返回 null。
 */
export function parseFixed(text: string, scale: number, options: { round?: boolean } = {}) {
  const match = DECIMAL.exec(text.trim());
  if (!match) return null;
  const [, sign, whole = '0', fraction = ''] = match;
  if (fraction.length > scale && !options.round) return null;
  const digits = BigInt(whole + fraction) * (sign ? -1n : 1n);
  return rescale({ value: digits, scale: fraction.length }, scale);
}

export function multiply(a: Fixed, b: Fixed, scale: number): Fixed {
  return rescale({ value: a.value * b.value, scale: a.scale + b.scale }, scale);
}

export function divide(a: Fixed, b: Fixed, scale: number): Fixed {
  const exponent = b.scale + scale - a.scale;
  if (exponent >= 0) return { value: divRound(a.value * POW10(exponent), b.value), scale };
  return { value: divRound(a.value, b.value * POW10(-exponent)), scale };
}

export function subtract(a: Fixed, b: Fixed): Fixed {
  const scale = Math.max(a.scale, b.scale);
  return { value: rescale(a, scale).value - rescale(b, scale).value, scale };
}

export function formatFixed(value: Fixed): string {
  const divisor = POW10(value.scale);
  const sign = value.value < 0n ? '-' : '';
  const absolute = value.value < 0n ? -value.value : value.value;
  const whole = absolute / divisor;
  if (value.scale === 0) return `${sign}${whole}`;
  const fraction = (absolute % divisor).toString().padStart(value.scale, '0');
  return `${sign}${whole}.${fraction}`;
}

/** 读取数据库 numeric 列（列精度已固定，按列精度解析）。 */
export function fixedFromDb(value: string, scale: number): Fixed {
  const parsed = parseFixed(value, scale, { round: true });
  if (!parsed) throw new Error(`数据库数值不合法：${value}`);
  return parsed;
}
