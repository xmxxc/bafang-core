import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { positions, trades, users } from '../db/schema';
import { shanghaiDate, shanghaiMinutesOfDay, type Clock } from '../clock';
import type { LatestNav, NavPoint, NavService } from '../market/nav';
import type { TradingCalendar } from '../trading-calendar';
import {
  add,
  divide,
  fixedFromDb,
  formatFixed,
  multiply,
  parseFixed,
  subtract,
  type Fixed,
} from './decimal';

const CALCULATION_SCALE = 18;
export const SETTLEMENT_RUN_MINUTES = 21 * 60 + 30;
const SCHEDULER_INTERVAL_MS = 60_000;

export interface SettlementFailure {
  tradeId: string;
  reason: string;
}

export interface SettlementSummary {
  confirmed: number;
  pending: number;
  failed: number;
  failures: SettlementFailure[];
}

export interface SettlementJob {
  run(): Promise<SettlementSummary>;
}

interface Candidate {
  id: string;
  positionId: string;
  type: 'buy' | 'sell' | 'switch_out' | 'switch_in';
  applicationDate: string;
  amount: string | null;
  feeRate: string;
  fundCode: string;
  userId: string;
}

function exactNav(
  latest: LatestNav | null,
  history: NavPoint[] | null,
  date: string,
): NavPoint | null {
  if (latest?.navDate === date) {
    return {
      date: latest.navDate,
      unitNav: latest.unitNav,
      cumulativeNav: latest.cumulativeNav,
      dailyChange: latest.dailyChange,
    };
  }
  return history?.find((point) => point.date === date) ?? null;
}

async function findNav(nav: NavService, fundCode: string, date: string): Promise<NavPoint | null> {
  // A future/latest point is not sufficient: confirmation must use the application date's NAV.
  const latest = await nav.latest(fundCode);
  if (latest?.navDate === date) return exactNav(latest, null, date);
  const recentHistory = await nav.history(fundCode, '1m');
  const recent = exactNav(latest, recentHistory, date);
  if (recent) return recent;
  // A long-delayed or manually backfilled trade can be older than one month.
  const longHistory = await nav.history(fundCode, '1y');
  return exactNav(latest, longHistory, date);
}

function confirmationShares(amountText: string, feeRateText: string, navText: string): Fixed {
  const amount = parseFixed(amountText, 2);
  const feeRate = parseFixed(feeRateText, 6);
  const nav = parseFixed(navText, 4, { round: true });
  if (!amount || !feeRate || !nav || nav.value <= 0n) {
    throw new Error('确认所需的金额、费率或净值无效');
  }
  // amount / (1 + feeRate) is algebraically identical to
  // (amount - amount * feeRate / (1 + feeRate)); retain 18 decimal places
  // here and round only the final share result to four places.
  const denominator: Fixed = { value: 10n ** 6n + feeRate.value, scale: 6 };
  const netAmount = divide(amount, denominator, CALCULATION_SCALE);
  return divide(netAmount, nav, 4);
}

export function createSettlementJob(deps: {
  db: Db;
  nav: NavService;
  clock: Clock;
}): SettlementJob {
  async function candidates(today: string): Promise<Candidate[]> {
    return deps.db
      .select({
        id: trades.id,
        positionId: trades.positionId,
        type: trades.type,
        applicationDate: trades.applicationDate,
        amount: trades.amount,
        feeRate: trades.feeRate,
        fundCode: positions.fundCode,
        userId: positions.userId,
      })
      .from(trades)
      .innerJoin(positions, eq(positions.id, trades.positionId))
      .where(and(eq(trades.status, 'pending'), lte(trades.settlementDate, today)))
      .orderBy(asc(trades.applicationDate), asc(trades.createdAt), asc(trades.id));
  }

  async function confirm(candidate: Candidate, navPoint: NavPoint): Promise<boolean> {
    return deps.db.transaction(async (tx) => {
      // All trade and position writes use the user lock first. This is the same
      // lock order as submit/cancel/calibrate and prevents cross-operation deadlocks.
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, candidate.userId))
        .for('update');
      const [trade] = await tx
        .select({
          id: trades.id,
          type: trades.type,
          shares: trades.shares,
          amount: trades.amount,
          feeRate: trades.feeRate,
          positionId: trades.positionId,
          status: trades.status,
        })
        .from(trades)
        .where(and(eq(trades.id, candidate.id), eq(trades.status, 'pending')))
        .for('update');
      if (!trade || trade.positionId !== candidate.positionId) return false;
      const [position] = await tx
        .select()
        .from(positions)
        .where(and(eq(positions.id, candidate.positionId), eq(positions.userId, candidate.userId)))
        .for('update');
      if (!position) throw new Error('交易对应的持仓不存在');
      const currentShares = fixedFromDb(position.shares, 4);
      const currentCost = fixedFromDb(position.totalCost, 2);
      let confirmedShares: Fixed;
      let proceeds: string | null = null;
      if (trade.type === 'buy') {
        if (!trade.amount) throw new Error('加仓交易缺少金额');
        confirmedShares = confirmationShares(trade.amount, trade.feeRate, navPoint.unitNav);
        await tx
          .update(positions)
          .set({
            shares: formatFixed(add(currentShares, confirmedShares)),
            totalCost: formatFixed(add(currentCost, fixedFromDb(trade.amount, 2))),
            updatedAt: deps.clock.now(),
          })
          .where(eq(positions.id, candidate.positionId));
      } else if (trade.type === 'sell') {
        if (!trade.shares) throw new Error('减仓交易缺少份额');
        confirmedShares = fixedFromDb(trade.shares, 4);
        if (confirmedShares.value <= 0n || confirmedShares.value > currentShares.value) {
          throw new Error('减仓份额超过当前已确认份额，请校准后重试');
        }
        const nav = parseFixed(navPoint.unitNav, 4, { round: true });
        if (!nav || nav.value <= 0n) throw new Error('确认净值无效');
        const feeRate = fixedFromDb(trade.feeRate, 6);
        // Preserve every digit of both products and round only the final amount.
        const gross = multiply(confirmedShares, nav, 8);
        const net = multiply(gross, { value: 1_000_000n - feeRate.value, scale: 6 }, 2);
        // Selling all remaining shares carries the entire remaining cost, including rounding residue.
        const cost =
          confirmedShares.value === currentShares.value
            ? currentCost
            : divide(multiply(currentCost, confirmedShares, 6), currentShares, 2);
        proceeds = formatFixed(net);
        await tx
          .update(positions)
          .set({
            shares: formatFixed(subtract(currentShares, confirmedShares)),
            totalCost: formatFixed(subtract(currentCost, cost)),
            realizedGain: formatFixed(
              add(fixedFromDb(position.realizedGain, 2), subtract(net, cost)),
            ),
            realizedGainCost: formatFixed(add(fixedFromDb(position.realizedGainCost, 2), cost)),
            updatedAt: deps.clock.now(),
          })
          .where(eq(positions.id, candidate.positionId));
      } else {
        throw new Error(`暂不支持确认交易类型：${trade.type}`);
      }
      const [updated] = await tx
        .update(trades)
        .set({
          status: 'confirmed',
          confirmedNav: formatFixed(parseFixed(navPoint.unitNav, 4, { round: true })!),
          confirmedShares: formatFixed(confirmedShares),
          ...(proceeds === null ? {} : { amount: proceeds }),
        })
        .where(and(eq(trades.id, candidate.id), eq(trades.status, 'pending')))
        .returning({ id: trades.id });
      return Boolean(updated);
    });
  }

  return {
    async run(): Promise<SettlementSummary> {
      const today = shanghaiDate(deps.clock.now());
      const summary: SettlementSummary = { confirmed: 0, pending: 0, failed: 0, failures: [] };
      let rows: Candidate[];
      try {
        rows = await candidates(today);
      } catch (error) {
        summary.failed = 1;
        summary.failures.push({
          tradeId: 'batch',
          reason: error instanceof Error ? error.message : '读取待确认交易失败',
        });
        return summary;
      }
      const blockedPositions = new Set<string>();
      for (const candidate of rows) {
        if (blockedPositions.has(candidate.positionId)) continue;
        try {
          if (candidate.type !== 'buy' && candidate.type !== 'sell')
            throw new Error(`暂不支持确认交易类型：${candidate.type}`);
          const navPoint = await findNav(deps.nav, candidate.fundCode, candidate.applicationDate);
          if (!navPoint) {
            blockedPositions.add(candidate.positionId);
            continue;
          }
          if (await confirm(candidate, navPoint)) summary.confirmed++;
        } catch (error) {
          blockedPositions.add(candidate.positionId);
          summary.failed++;
          summary.failures.push({
            tradeId: candidate.id,
            reason: error instanceof Error ? error.message : '确认交易失败',
          });
        }
      }
      try {
        const [pending] = await deps.db
          .select({ count: sql<number>`count(*)` })
          .from(trades)
          .where(eq(trades.status, 'pending'));
        summary.pending = Number(pending?.count ?? 0);
      } catch (error) {
        summary.failed++;
        summary.failures.push({
          tradeId: 'batch',
          reason: error instanceof Error ? error.message : '读取在途交易数失败',
        });
      }
      return summary;
    },
  };
}

export function startSettlementScheduler(
  job: SettlementJob,
  deps: { clock: Clock; calendar: TradingCalendar },
  options: { intervalMs?: number; runMinutes?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? SCHEDULER_INTERVAL_MS;
  const runMinutes = options.runMinutes ?? SETTLEMENT_RUN_MINUTES;
  let lastRunDate: string | null = null;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const now = deps.clock.now();
    const date = shanghaiDate(now);
    if (
      deps.calendar.isTradingDay(now) &&
      shanghaiMinutesOfDay(now) >= runMinutes &&
      lastRunDate !== date
    ) {
      lastRunDate = date;
      try {
        const summary = await job.run();
        console.log('[bafang-core] trade settlement', JSON.stringify(summary));
      } catch (error) {
        console.error('[bafang-core] trade settlement failed', error);
      }
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
