import { shanghaiMinutesOfDay } from '../clock';
import type { TradingCalendar } from '../trading-calendar';

/**
 * 市场状态。四种状态都是显式枚举，绝不用 0 或空值表示：
 * - trading    交易中（交易日 09:30–15:00）
 * - closed     已收盘（交易日 15:00 之后）
 * - pre_market 盘前（交易日 09:30 之前）
 * - holiday    休市（周末或休市日）
 */
export type MarketStatus = 'trading' | 'closed' | 'holiday' | 'pre_market';

/** A 股连续竞价开盘时刻：09:30 Asia/Shanghai。 */
const MARKET_OPEN_MINUTES = 9 * 60 + 30;
/** A 股收盘时刻：15:00 Asia/Shanghai。 */
const MARKET_CLOSE_MINUTES = 15 * 60;

export function marketStatus(now: Date, calendar: TradingCalendar): MarketStatus {
  if (!calendar.isTradingDay(now)) return 'holiday';
  const minutes = shanghaiMinutesOfDay(now);
  if (minutes < MARKET_OPEN_MINUTES) return 'pre_market';
  if (minutes >= MARKET_CLOSE_MINUTES) return 'closed';
  return 'trading';
}
