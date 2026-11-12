import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { channels, positions, switches, trades, users } from '../db/schema';
import { shanghaiDate, shanghaiMinutesOfDay, type Clock } from '../clock';
import type { FundService } from '../market/funds';
import type { TradingCalendar } from '../trading-calendar';
import { fixedFromDb, formatFixed, parseFixed, subtract } from '../fixed-point';
import { PositionError } from './service';

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type TradeRow = typeof trades.$inferSelect;
export type TradeView = Omit<TradeRow, 'createdAt'>;

interface TradeTiming {
  feeRate: string;
  submittedDate?: string;
  beforeCutoff?: boolean;
}

export type TradeInput = TradeTiming &
  ({ type: 'buy'; amount: string } | { type: 'sell'; shares: string });

export interface SwitchInput {
  targetFundCode: string;
  targetChannelId: string;
  shares: string;
  outFeeRate: string;
  inFeeRate: string;
  submittedDate?: string;
  beforeCutoff?: boolean;
}
export interface SwitchView {
  id: string;
  sourcePositionId: string;
  targetFundCode: string;
  items: TradeView[];
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

  async function requireAvailableShares(
    tx: Transaction,
    position: typeof positions.$inferSelect,
    quantity: bigint,
  ) {
    const [reserved] = await tx
      .select({ shares: sql<string>`coalesce(sum(${trades.shares}), 0)::text` })
      .from(trades)
      .where(
        and(
          eq(trades.positionId, position.id),
          eq(trades.status, 'pending'),
          inArray(trades.type, ['sell', 'switch_out']),
        ),
      );
    const available = subtract(fixedFromDb(position.shares, 4), fixedFromDb(reserved!.shares, 4));
    if (quantity > available.value)
      throw new PositionError(
        'insufficient_shares',
        '减仓份额超过可用份额（已扣除在途减仓与调仓转出）',
        409,
      );
  }

  async function ownedSwitch(db: Db | Transaction, userId: string, id: string) {
    const [row] = await db
      .select({
        id: switches.id,
        sourcePositionId: switches.sourcePositionId,
        targetFundCode: switches.targetFundCode,
      })
      .from(switches)
      .innerJoin(positions, eq(positions.id, switches.sourcePositionId))
      .where(and(eq(switches.id, id), eq(positions.userId, userId)));
    if (!row) throw new PositionError('not_found', '调仓不存在', 404);
    return row;
  }

  async function cancelPair(tx: Transaction, switchId: string) {
    const pair = await tx.select().from(trades).where(eq(trades.switchId, switchId)).for('update');
    if (
      pair.length !== 2 ||
      pair.some(
        (trade) =>
          trade.status !== 'pending' || shanghaiDate(deps.clock.now()) >= trade.settlementDate,
      )
    ) {
      throw new PositionError('trade_not_cancellable', '仅可在两侧确认日前撤销成对在途交易', 409);
    }
    await tx.delete(switches).where(eq(switches.id, switchId));
  }

  return {
    async create(userId: string, positionId: string, input: TradeInput): Promise<TradeView> {
      const quantity = parseFixed(
        input.type === 'buy' ? input.amount : input.shares,
        input.type === 'buy' ? 2 : 4,
      );
      if (!quantity || quantity.value <= 0n)
        throw new PositionError('validation_error', '交易金额或份额必须大于 0', 400);
      const now = deps.clock.now();
      const position = await ownedPosition(deps.db, userId, positionId);
      // 网络请求在事务外；获取基金详情中已存在的 T+N 规则（普通基金缺省 T+1）。
      const fund = await deps.funds.get(position.fundCode);
      if (!fund) throw new PositionError('fund_not_found', '基金不存在', 404);
      return mutate(userId, async (tx) => {
        const current = await ownedPosition(tx, userId, positionId);
        if (input.type === 'sell') {
          await requireAvailableShares(tx, current, quantity.value);
        }
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
            type: input.type,
            status: 'pending',
            amount: input.type === 'buy' ? formatFixed(quantity) : null,
            shares: input.type === 'sell' ? formatFixed(quantity) : null,
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

    async createSwitch(
      userId: string,
      positionId: string,
      input: SwitchInput,
    ): Promise<SwitchView> {
      const quantity = parseFixed(input.shares, 4);
      if (!quantity || quantity.value <= 0n)
        throw new PositionError('validation_error', '调仓份额必须大于 0', 400);
      const now = deps.clock.now();
      const position = await ownedPosition(deps.db, userId, positionId);
      const [channel] = await deps.db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.id, input.targetChannelId), eq(channels.userId, userId)));
      if (!channel) throw new PositionError('not_found', '渠道不存在', 404);
      if (position.channelId !== channel.id)
        throw new PositionError('validation_error', '调仓必须在同一渠道内', 400);
      if (position.fundCode === input.targetFundCode)
        throw new PositionError('validation_error', '调仓的转入与转出基金必须不同', 400);
      const [outFund, inFund] = await Promise.all([
        deps.funds.get(position.fundCode),
        deps.funds.get(input.targetFundCode),
      ]);
      if (!outFund || !inFund) throw new PositionError('fund_not_found', '基金不存在', 404);
      const submittedDate = input.submittedDate ?? shanghaiDate(now);
      const beforeCutoff = input.beforeCutoff ?? shanghaiMinutesOfDay(now) < 15 * 60;
      const outDates = tradeDates(
        submittedDate,
        beforeCutoff,
        outFund.settlement.tPlusN,
        deps.calendar,
      );
      const inDates = tradeDates(
        submittedDate,
        beforeCutoff,
        inFund.settlement.tPlusN,
        deps.calendar,
      );
      return mutate(userId, async (tx) => {
        const current = await ownedPosition(tx, userId, positionId);
        if (current.channelId !== input.targetChannelId)
          throw new PositionError('validation_error', '调仓必须在同一渠道内', 400);
        await requireAvailableShares(tx, current, quantity.value);
        const [target] = await tx
          .select({ id: positions.id })
          .from(positions)
          .where(
            and(
              eq(positions.userId, userId),
              eq(positions.channelId, current.channelId),
              eq(positions.fundCode, input.targetFundCode),
            ),
          );
        const [transfer] = await tx
          .insert(switches)
          .values({ sourcePositionId: positionId, targetFundCode: input.targetFundCode })
          .returning();
        const common = { switchId: transfer!.id, submittedDate, beforeCutoff, source: 'web' };
        const rows = await tx
          .insert(trades)
          .values([
            {
              ...common,
              positionId,
              type: 'switch_out',
              shares: formatFixed(quantity),
              feeRate: formatFixed(parseFixed(input.outFeeRate, 6)!),
              ...outDates,
            },
            {
              ...common,
              positionId: target?.id ?? null,
              type: 'switch_in',
              feeRate: formatFixed(parseFixed(input.inFeeRate, 6)!),
              ...inDates,
            },
          ])
          .returning();
        return {
          ...transfer!,
          items: rows.sort((a, b) => b.type.localeCompare(a.type)).map(tradeView),
        };
      });
    },

    async getSwitch(userId: string, switchId: string): Promise<SwitchView> {
      const transfer = await ownedSwitch(deps.db, userId, switchId);
      const rows = await deps.db.select().from(trades).where(eq(trades.switchId, switchId));
      return {
        ...transfer,
        items: rows.sort((a, b) => b.type.localeCompare(a.type)).map(tradeView),
      };
    },

    async cancelSwitch(userId: string, switchId: string, tradeId: string): Promise<void> {
      await mutate(userId, async (tx) => {
        await ownedSwitch(tx, userId, switchId);
        const [trade] = await tx
          .select({ id: trades.id })
          .from(trades)
          .where(and(eq(trades.id, tradeId), eq(trades.switchId, switchId)));
        if (!trade) throw new PositionError('not_found', '交易不存在', 404);
        await cancelPair(tx, switchId);
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
        if (trade.switchId) {
          await cancelPair(tx, trade.switchId);
          return;
        }
        if (trade.status !== 'pending' || shanghaiDate(deps.clock.now()) >= trade.settlementDate) {
          throw new PositionError('trade_not_cancellable', '仅可在确认日前撤销在途交易', 409);
        }
        await tx.delete(trades).where(eq(trades.id, tradeId));
      });
    },
  };
}
