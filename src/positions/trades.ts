import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { positions, trades, users } from '../db/schema';
import { shanghaiDate, shanghaiMinutesOfDay, type Clock } from '../clock';
import type { FundService } from '../market/funds';
import type { TradingCalendar } from '../trading-calendar';
import { formatFixed, parseFixed } from './decimal';
import { PositionError } from './service';

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type TradeRow = typeof trades.$inferSelect;
export type TradeView = Omit<TradeRow, 'createdAt'>;

export interface BuyInput {
  type: 'buy';
  amount: string;
  feeRate: string;
  submittedDate?: string;
  beforeCutoff?: boolean;
}

function tradeView(row: TradeRow): TradeView {
  return {
    id: row.id,
    positionId: row.positionId,
    type: row.type,
    status: row.status,
    submittedDate: row.submittedDate,
    beforeCutoff: row.beforeCutoff,
    applicationDate: row.applicationDate,
    settlementDate: row.settlementDate,
    amount: row.amount,
    shares: row.shares,
    feeRate: row.feeRate,
    confirmedNav: row.confirmedNav,
    confirmedShares: row.confirmedShares,
    switchId: row.switchId,
    source: row.source,
  };
}

/** 上海日历日期向后推一天；UTC+8 无夏令时，每天固定 24 小时。 */
function nextDay(day: Date): Date {
  return new Date(day.getTime() + 24 * 3600_000);
}

function nextTradingDay(day: Date, calendar: TradingCalendar): Date {
  for (let count = 0; count < 366; count++) {
    day = nextDay(day);
    if (shanghaiDate(day).length !== 10) break;
    if (calendar.isTradingDay(day)) return day;
  }
  throw new PositionError('validation_error', '无法推算日期范围内的下一个交易日', 400);
}

/** 先按截止点归到申请交易日，再按基金 T+N 推算。持久化结果不随后续基金信息变化。 */
function tradeDates(
  submittedDate: string,
  beforeCutoff: boolean,
  tPlusN: number,
  calendar: TradingCalendar,
) {
  let day = new Date(`${submittedDate}T00:00:00+08:00`);
  if (!beforeCutoff || !calendar.isTradingDay(day)) day = nextTradingDay(day, calendar);
  const applicationDate = shanghaiDate(day);
  for (let n = 0; n < tPlusN; n++) day = nextTradingDay(day, calendar);
  return { applicationDate, settlementDate: shanghaiDate(day) };
}

export function createTradeService(deps: {
  db: Db;
  funds: FundService;
  clock: Clock;
  calendar: TradingCalendar;
}) {
  async function ownedPosition(db: Db | Transaction, userId: string, id: string) {
    const [position] = await db
      .select()
      .from(positions)
      .where(and(eq(positions.userId, userId), eq(positions.id, id)))
      .limit(1);
    if (!position) throw new PositionError('not_found', '持仓不存在', 404);
    return position;
  }

  /** 与持仓、渠道写入共用用户行锁，避免提交与删除/校准相互穿插。 */
  async function mutate<T>(userId: string, action: (tx: Transaction) => Promise<T>) {
    return deps.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      return action(tx);
    });
  }

  return {
    async create(userId: string, positionId: string, input: BuyInput): Promise<TradeView> {
      const amount = parseFixed(input.amount, 2)!;
      if (amount.value <= 0n)
        throw new PositionError('validation_error', '加仓金额必须大于 0', 400);
      const now = deps.clock.now();
      const position = await ownedPosition(deps.db, userId, positionId);
      // 网络请求在事务外；获取基金详情中已存在的 T+N 规则（普通基金缺省 T+1）。
      const fund = await deps.funds.get(position.fundCode);
      if (!fund) throw new PositionError('fund_not_found', '基金不存在', 404);
      return mutate(userId, async (tx) => {
        await ownedPosition(tx, userId, positionId);
        const submittedDate = input.submittedDate ?? shanghaiDate(now);
        const beforeCutoff = input.beforeCutoff ?? shanghaiMinutesOfDay(now) < 15 * 60;
        const dates = tradeDates(
          submittedDate,
          beforeCutoff,
          fund.settlement.tPlusN,
          deps.calendar,
        );
        const [created] = await tx
          .insert(trades)
          .values({
            positionId,
            type: 'buy',
            status: 'pending',
            amount: formatFixed(amount),
            feeRate: formatFixed(parseFixed(input.feeRate, 6)!),
            submittedDate,
            beforeCutoff,
            ...dates,
            source: 'web',
          })
          .returning();
        return tradeView(created!);
      });
    },

    async list(userId: string, positionId: string): Promise<TradeView[]> {
      await ownedPosition(deps.db, userId, positionId);
      const rows = await deps.db
        .select()
        .from(trades)
        .where(eq(trades.positionId, positionId))
        .orderBy(asc(trades.createdAt), asc(trades.id));
      return rows.map(tradeView);
    },

    async cancel(userId: string, positionId: string, tradeId: string): Promise<void> {
      await mutate(userId, async (tx) => {
        await ownedPosition(tx, userId, positionId);
        const [trade] = await tx
          .select()
          .from(trades)
          .where(and(eq(trades.id, tradeId), eq(trades.positionId, positionId)))
          .for('update');
        if (!trade) throw new PositionError('not_found', '交易不存在', 404);
        if (trade.status !== 'pending' || shanghaiDate(deps.clock.now()) >= trade.settlementDate) {
          throw new PositionError('trade_not_cancellable', '仅可在确认日前撤销在途交易', 409);
        }
        await tx.delete(trades).where(eq(trades.id, tradeId));
      });
    },
  };
}
