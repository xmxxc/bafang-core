import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { channels, positions, trades, users } from '../db/schema';
import type { ErrorCode } from '../errors';
import type { FundService } from '../market/funds';
import type { LatestNav, NavService } from '../market/nav';
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

export interface PositionView {
  id: string;
  fundCode: string;
  channelId: string;
  shares: string;
  totalCost: string;
  pendingAmount: string;
  unitPrice: string | null;
  snapshotDate: string;
  nav: string | null;
  navDate: string | null;
  marketValue: string | null;
  holdingGain: string | null;
  holdingGainRate: string | null;
}

export interface PositionService {
  list(userId: string, channelId?: string): Promise<PositionView[]>;
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

/**
 * 渠道删除规则（#15）：在调用方事务里查询该渠道下是否有未清仓持仓。
 * #16 还没有交易，未清仓即份额大于 0；#17 引入在途交易后由 #19 一并补全。
 */
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
        gt(positions.shares, '0'),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** 渠道下是否有任何持仓（含已清仓）；#19 把已清仓持仓移到“未指定”之前，渠道删除用它兜底。 */
export async function channelHasAnyPositions(
  tx: Transaction,
  userId: string,
  channelId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: positions.id })
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.channelId, channelId)))
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
): PositionView {
  const shares = fixedFromDb(row.shares, SHARES_SCALE);
  const totalCost = fixedFromDb(row.totalCost, AMOUNT_SCALE);
  const base = {
    id: row.id,
    fundCode: row.fundCode,
    channelId: row.channelId,
    shares: formatFixed(shares),
    pendingAmount,
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
}): PositionService {
  async function latestNav(code: string): Promise<LatestNav | null> {
    try {
      return await deps.nav.latest(code);
    } catch {
      // 行情暂不可用时仍返回持仓本身，市值与收益明确为 null。
      return null;
    }
  }

  // 一次聚合所有待展示持仓，避免列表为每个持仓单独查询在途交易。
  async function views(rows: PositionRow[]): Promise<PositionView[]> {
    if (rows.length === 0) return [];
    const totals = await deps.db
      .select({
        positionId: trades.positionId,
        amount: sql<string>`sum(${trades.amount})::text`,
      })
      .from(trades)
      .where(
        and(
          inArray(
            trades.positionId,
            rows.map((row) => row.id),
          ),
          eq(trades.status, 'pending'),
          eq(trades.type, 'buy'),
        ),
      )
      .groupBy(trades.positionId);
    const amounts = new Map(
      totals.map((total) => [
        total.positionId,
        formatFixed(fixedFromDb(total.amount, AMOUNT_SCALE)),
      ]),
    );
    return Promise.all(
      rows.map(async (row) =>
        positionView(row, await latestNav(row.fundCode), amounts.get(row.id) ?? '0.00'),
      ),
    );
  }

  async function view(row: PositionRow): Promise<PositionView> {
    return (await views([row]))[0]!;
  }

  /** 与渠道、登录方式一致：写操作先锁住用户行，串行化同一用户的并发修改。 */
  async function mutate<T>(userId: string, action: (tx: Transaction) => Promise<T>) {
    return deps.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      return action(tx);
    });
  }

  return {
    async list(userId, channelId) {
      const rows = await deps.db
        .select()
        .from(positions)
        .where(
          channelId
            ? and(eq(positions.userId, userId), eq(positions.channelId, channelId))
            : eq(positions.userId, userId),
        )
        .orderBy(positions.createdAt, positions.id);
      return views(rows);
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
