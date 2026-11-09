import { and, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { channels, positions, trades, users } from '../db/schema';
import type { ErrorCode } from '../errors';
import type { FundService } from '../market/funds';
import type { LatestNav, NavService } from '../market/nav';
import type { EstimateService } from '../market/estimates';
import type { TradingCalendar } from '../trading-calendar';
import { createPositionGains, type PositionGains, type QuotedPosition } from './gains';
import { shanghaiDate, type Clock } from '../clock';
import {
  divide,
  fixedFromDb,
  formatFixed,
  multiply,
  parseFixed,
  subtract,
  type Fixed,
} from './decimal';

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type PositionRow = typeof positions.$inferSelect;

const SHARES_SCALE = 4;
const AMOUNT_SCALE = 2;
const PRICE_SCALE = 4;
const RATE_SCALE = 4;
/** total_cost 是 numeric(24, 2)；换算出的总成本（以分计）达到这个值视为输入不合法，而不是让数据库报错。 */
const MAX_TOTAL_COST_CENTS = 10n ** 20n;

export class PositionError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'PositionError';
  }
}

/** 份额与成本的输入：十进制字符串，总成本与单价二选一。 */
export interface CostInput {
  shares: string;
  totalCost?: string;
  unitPrice?: string;
}

export interface PositionCreateInput extends CostInput {
  fundCode: string;
  channelId: string;
  snapshotDate?: string;
}

export interface PositionValuation {
  id: string;
  fundCode: string;
  channelId: string;
  shares: string;
  totalCost: string;
  pendingAmount: string;
  pendingShares: string;
  availableShares: string;
  isCleared: boolean;
  realizedGain: string;
  realizedGainCost: string;
  unitPrice: string | null;
  snapshotDate: string;
  nav: string | null;
  navDate: string | null;
  marketValue: string | null;
  holdingGain: string | null;
  holdingGainRate: string | null;
}

export type PositionView = PositionValuation & PositionGains;

export interface PositionService {
  list(userId: string, channelId?: string, includeCleared?: boolean): Promise<PositionView[]>;
  listWithQuotes(
    userId: string,
    channelId?: string,
    includeCleared?: boolean,
  ): Promise<QuotedPosition[]>;
  get(userId: string, id: string): Promise<PositionView>;
  create(userId: string, input: PositionCreateInput): Promise<PositionView>;
  calibrate(userId: string, id: string, input: CostInput): Promise<PositionView>;
  delete(userId: string, id: string): Promise<void>;
}

/** 空用户判定（#12）：在调用方事务里查询用户是否有任何持仓，已清仓的也算。 */
export async function userHasPositions(tx: Transaction, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.userId, userId))
    .limit(1);
  return Boolean(row);
}

/** 与列表的已清仓定义一致：有份额或任意在途交易的持仓仍占用渠道。 */
export async function channelHasPositions(
  tx: Transaction,
  userId: string,
  channelId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: positions.id })
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        eq(positions.channelId, channelId),
        or(
          gt(positions.shares, '0'),
          sql`exists (select 1 from ${trades} where ${trades.positionId} = ${positions.id} and ${trades.status} = 'pending')`,
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

function invalid(message: string): never {
  throw new PositionError('validation_error', message, 400);
}

/** 解析份额与成本；单价换算总成本 = 份额 × 单价，四舍五入到 2 位。 */
export function readCost(input: CostInput): { shares: Fixed; totalCost: Fixed } {
  if ((input.totalCost === undefined) === (input.unitPrice === undefined)) {
    invalid('总成本与单价必须且只能填写一个');
  }
  const shares = parseFixed(input.shares, SHARES_SCALE);
  if (!shares || shares.value < 0n) invalid('份额为非负十进制数，最多 4 位小数');
  let totalCost: Fixed;
  if (input.totalCost !== undefined) {
    const parsed = parseFixed(input.totalCost, AMOUNT_SCALE);
    if (!parsed || parsed.value < 0n) invalid('总成本为非负十进制数，最多 2 位小数');
    totalCost = parsed;
  } else {
    const unitPrice = parseFixed(input.unitPrice!, PRICE_SCALE);
    if (!unitPrice || unitPrice.value < 0n) invalid('单价为非负十进制数，最多 4 位小数');
    totalCost = multiply(shares, unitPrice, AMOUNT_SCALE);
  }
  if (totalCost.value >= MAX_TOTAL_COST_CENTS) invalid('总成本过大');
  return { shares, totalCost };
}

/** 由持仓行和最新净值算出对外视图；没有净值时市值与收益为 null。 */
export function positionView(
  row: PositionRow,
  latest: LatestNav | null,
  pendingAmount = '0.00',
  pendingShares = '0.0000',
  hasPending = false,
): PositionValuation {
  const shares = fixedFromDb(row.shares, SHARES_SCALE);
  const totalCost = fixedFromDb(row.totalCost, AMOUNT_SCALE);
  const available = subtract(shares, fixedFromDb(pendingShares, SHARES_SCALE));
  const base = {
    id: row.id,
    fundCode: row.fundCode,
    channelId: row.channelId,
    shares: formatFixed(shares),
    pendingAmount,
    pendingShares,
    availableShares: formatFixed({
      value: available.value < 0n ? 0n : available.value,
      scale: SHARES_SCALE,
    }),
    isCleared: shares.value === 0n && !hasPending,
    realizedGain: row.realizedGain,
    realizedGainCost: row.realizedGainCost,
    totalCost: formatFixed(totalCost),
    unitPrice: shares.value === 0n ? null : formatFixed(divide(totalCost, shares, PRICE_SCALE)),
    snapshotDate: row.snapshotDate,
  };
  const nav = latest ? parseFixed(latest.unitNav, PRICE_SCALE, { round: true }) : null;
  if (!latest || !nav) {
    return {
      ...base,
      nav: null,
      navDate: null,
      marketValue: null,
      holdingGain: null,
      holdingGainRate: null,
    };
  }
  const marketValue = multiply(shares, nav, AMOUNT_SCALE);
  const holdingGain = subtract(marketValue, totalCost);
  return {
    ...base,
    nav: formatFixed(nav),
    navDate: latest.navDate,
    marketValue: formatFixed(marketValue),
    holdingGain: formatFixed(holdingGain),
    holdingGainRate:
      totalCost.value === 0n ? null : formatFixed(divide(holdingGain, totalCost, RATE_SCALE)),
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let cause = error;
  while (cause && typeof cause === 'object') {
    if (
      'code' in cause &&
      cause.code === '23505' &&
      'constraint' in cause &&
      cause.constraint === constraint
    ) {
      return true;
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}

export function createPositionService(deps: {
  db: Db;
  funds: FundService;
  nav: NavService;
  clock: Clock;
  estimates: EstimateService;
  calendar: TradingCalendar;
}): PositionService {
  const withGains = createPositionGains(deps);
  async function latestNav(code: string): Promise<LatestNav | null> {
    try {
      return await deps.nav.latest(code);
    } catch {
      // 行情暂不可用时仍返回持仓本身，市值与收益明确为 null。
      return null;
    }
  }

  // 一次聚合所有待展示持仓，避免列表为每个持仓单独查询在途交易。
  async function views(rows: PositionRow[]): Promise<QuotedPosition[]> {
    if (rows.length === 0) return [];
    const totals = await deps.db
      .select({
        positionId: trades.positionId,
        amount: sql<string>`coalesce(sum(${trades.amount}) filter (where ${trades.type} = 'buy'), 0)::text`,
        shares: sql<string>`coalesce(sum(${trades.shares}) filter (where ${trades.type} in ('sell', 'switch_out')), 0)::text`,
      })
      .from(trades)
      .where(
        and(
          inArray(
            trades.positionId,
            rows.map((row) => row.id),
          ),
          eq(trades.status, 'pending'),
        ),
      )
      .groupBy(trades.positionId);
    const pending = new Map(totals.map((total) => [total.positionId, total]));
    const navs = new Map(
      await Promise.all(
        [...new Set(rows.map((row) => row.fundCode))].map(
          async (code) => [code, await latestNav(code)] as const,
        ),
      ),
    );
    return withGains(
      rows.map((row) => {
        const total = pending.get(row.id);
        return positionView(
          row,
          navs.get(row.fundCode) ?? null,
          total ? formatFixed(fixedFromDb(total.amount, AMOUNT_SCALE)) : '0.00',
          total ? formatFixed(fixedFromDb(total.shares, SHARES_SCALE)) : '0.0000',
          Boolean(total),
        );
      }),
    );
  }

  async function view(row: PositionRow): Promise<PositionView> {
    return withoutQuote((await views([row]))[0]!);
  }

  // 普通持仓接口保留原有响应；概览读取同一轮计算所使用的行情，避免再次抓取后数据不一致。
  function withoutQuote(item: QuotedPosition): PositionView {
    const { quote: _quote, ...position } = item;
    void _quote;
    return position;
  }

  /** 与渠道、登录方式一致：写操作先锁住用户行，串行化同一用户的并发修改。 */
  async function mutate<T>(userId: string, action: (tx: Transaction) => Promise<T>) {
    return deps.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      return action(tx);
    });
  }

  async function listWithQuotes(
    userId: string,
    channelId?: string,
    includeCleared = false,
  ): Promise<QuotedPosition[]> {
    if (channelId) {
      // 与渠道接口一致：不存在或别人的渠道都返回 404，而不是空列表。
      const [channel] = await deps.db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.userId, userId)))
        .limit(1);
      if (!channel) throw new PositionError('not_found', '渠道不存在', 404);
    }
    const rows = await deps.db
      .select()
      .from(positions)
      .where(
        channelId
          ? and(eq(positions.userId, userId), eq(positions.channelId, channelId))
          : eq(positions.userId, userId),
      )
      .orderBy(positions.createdAt, positions.id);
    const items = await views(rows);
    return includeCleared ? items : items.filter((item) => !item.isCleared);
  }

  return {
    listWithQuotes,
    async list(userId, channelId, includeCleared = false) {
      return (await listWithQuotes(userId, channelId, includeCleared)).map(withoutQuote);
    },

    async get(userId, id) {
      const [row] = await deps.db
        .select()
        .from(positions)
        .where(and(eq(positions.userId, userId), eq(positions.id, id)))
        .limit(1);
      if (!row) throw new PositionError('not_found', '持仓不存在', 404);
      return view(row);
    },

    async create(userId, input) {
      const values = readCost(input);
      if (values.shares.value === 0n) invalid('新建持仓的份额必须大于 0');
      // 基金校验走上游（有缓存），放在事务外，避免持锁等待网络。
      if (!(await deps.funds.get(input.fundCode))) {
        throw new PositionError('fund_not_found', `没有代码为 ${input.fundCode} 的基金`, 404);
      }
      let row: PositionRow;
      try {
        row = await mutate(userId, async (tx) => {
          const [channel] = await tx
            .select({ id: channels.id })
            .from(channels)
            .where(and(eq(channels.id, input.channelId), eq(channels.userId, userId)))
            .limit(1);
          if (!channel) throw new PositionError('not_found', '渠道不存在', 404);
          const [created] = await tx
            .insert(positions)
            .values({
              userId,
              channelId: input.channelId,
              fundCode: input.fundCode,
              shares: formatFixed(values.shares),
              totalCost: formatFixed(values.totalCost),
              snapshotDate: input.snapshotDate ?? shanghaiDate(deps.clock.now()),
            })
            .returning();
          return created!;
        });
      } catch (error) {
        if (isUniqueViolation(error, 'positions_user_fund_channel_uidx')) {
          throw new PositionError('position_exists', '该渠道已有这只基金的持仓', 409);
        }
        throw error;
      }
      return view(row);
    },

    async calibrate(userId, id, input) {
      const values = readCost(input);
      const row = await mutate(userId, async (tx) => {
        const [updated] = await tx
          .update(positions)
          .set({
            shares: formatFixed(values.shares),
            totalCost: formatFixed(values.totalCost),
            updatedAt: deps.clock.now(),
          })
          .where(and(eq(positions.id, id), eq(positions.userId, userId)))
          .returning();
        if (!updated) throw new PositionError('not_found', '持仓不存在', 404);
        return updated;
      });
      return view(row);
    },

    async delete(userId, id) {
      await mutate(userId, async (tx) => {
        const removed = await tx
          .delete(positions)
          .where(and(eq(positions.id, id), eq(positions.userId, userId)))
          .returning({ id: positions.id });
        if (removed.length === 0) throw new PositionError('not_found', '持仓不存在', 404);
      });
    },
  };
}
