import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db';
import { positions, switches, trades, users } from '../db/schema';
import { shanghaiDate, shanghaiMinutesOfDay, type Clock } from '../clock';
import type { LatestNav, NavPoint, NavService } from '../market/nav';
import type { TradingCalendar } from '../trading-calendar';
import { linkPendingSwitchIns } from './switch-targets';
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
export const DEFAULT_SETTLEMENT_RUN_MINUTES = [21 * 60 + 30, 22 * 60 + 30, 23 * 60 + 30] as const;
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

export interface SettlementScheduler {
  (): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
}

interface Candidate {
  id: string;
  channelId: string;
  switchId: string | null;
  type: 'buy' | 'sell' | 'switch_out' | 'switch_in';
  applicationDate: string;
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
    const source = alias(positions, 'switch_source');
    return deps.db
      .select({
        id: trades.id,
        type: trades.type,
        applicationDate: trades.applicationDate,
        fundCode: sql<string>`case when ${trades.type} = 'switch_in' then ${switches.targetFundCode} else ${positions.fundCode} end`,
        userId: sql<string>`coalesce(${positions.userId}, ${source.userId})`,
        channelId: sql<string>`coalesce(${positions.channelId}, ${source.channelId})`,
        switchId: trades.switchId,
      })
      .from(trades)
      .leftJoin(positions, eq(positions.id, trades.positionId))
      .leftJoin(switches, eq(switches.id, trades.switchId))
      .leftJoin(source, eq(source.id, switches.sourcePositionId))
      .where(and(eq(trades.status, 'pending'), lte(trades.settlementDate, today)))
      .orderBy(
        asc(trades.applicationDate),
        asc(trades.createdAt),
        sql`case when ${trades.type} = 'switch_in' then 1 else 0 end`,
        asc(trades.id),
      );
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
        .select()
        .from(trades)
        .where(and(eq(trades.id, candidate.id), eq(trades.status, 'pending')))
        .for('update');
      if (!trade) return false;
      let position;
      if (trade.type === 'switch_in') {
        if (!trade.switchId) throw new Error('调仓转入缺少关联 ID');
        const [out] = await tx
          .select()
          .from(trades)
          .where(and(eq(trades.switchId, trade.switchId), eq(trades.type, 'switch_out')));
        if (out?.status !== 'confirmed') return false;
        if (trade.amount === null) throw new Error('调仓转入缺少到账金额');
        [position] = await tx
          .select()
          .from(positions)
          .where(
            and(
              eq(positions.userId, candidate.userId),
              eq(positions.channelId, candidate.channelId),
              eq(positions.fundCode, candidate.fundCode),
            ),
          )
          .for('update');
        if (!position) {
          [position] = await tx
            .insert(positions)
            .values({
              userId: candidate.userId,
              channelId: candidate.channelId,
              fundCode: candidate.fundCode,
              shares: '0',
              totalCost: '0',
              snapshotDate: candidate.applicationDate,
            })
            .returning();
          await linkPendingSwitchIns(tx, position!);
        }
      } else if (trade.positionId) {
        [position] = await tx
          .select()
          .from(positions)
          .where(and(eq(positions.id, trade.positionId), eq(positions.userId, candidate.userId)))
          .for('update');
      }
      if (!position) throw new Error('交易对应的持仓不存在');
      const currentShares = fixedFromDb(position.shares, 4);
      const currentCost = fixedFromDb(position.totalCost, 2);
      let confirmedShares: Fixed;
      let proceeds: string | null = null;
      if (trade.type === 'buy' || trade.type === 'switch_in') {
        if (!trade.amount) throw new Error('加仓交易缺少金额');
        confirmedShares = confirmationShares(trade.amount, trade.feeRate, navPoint.unitNav);
        await tx
          .update(positions)
          .set({
            shares: formatFixed(add(currentShares, confirmedShares)),
            totalCost: formatFixed(add(currentCost, fixedFromDb(trade.amount, 2))),
            updatedAt: deps.clock.now(),
          })
          .where(eq(positions.id, position.id));
      } else if (trade.type === 'sell' || trade.type === 'switch_out') {
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
          .where(eq(positions.id, position.id));
      } else {
        throw new Error(`暂不支持确认交易类型：${trade.type}`);
      }
      const [updated] = await tx
        .update(trades)
        .set({
          status: 'confirmed',
          positionId: position.id,
          confirmedNav: formatFixed(parseFixed(navPoint.unitNav, 4, { round: true })!),
          confirmedShares: formatFixed(confirmedShares),
          ...(proceeds === null ? {} : { amount: proceeds }),
        })
        .where(and(eq(trades.id, candidate.id), eq(trades.status, 'pending')))
        .returning({ id: trades.id });
      if (updated && trade.type === 'switch_out' && trade.switchId) {
        await tx
          .update(trades)
          .set({ amount: proceeds })
          .where(
            and(
              eq(trades.switchId, trade.switchId),
              eq(trades.type, 'switch_in'),
              eq(trades.status, 'pending'),
            ),
          );
      }
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
        // Use the fund/channel identity even before a target position exists.
        const positionKey = `${candidate.userId}:${candidate.channelId}:${candidate.fundCode}`;
        if (blockedPositions.has(positionKey)) continue;
        try {
          if (candidate.type === 'switch_in' && candidate.switchId) {
            const [out] = await deps.db
              .select({ status: trades.status })
              .from(trades)
              .where(and(eq(trades.switchId, candidate.switchId), eq(trades.type, 'switch_out')));
            if (out?.status !== 'confirmed') {
              blockedPositions.add(positionKey);
              continue;
            }
          }
          const navPoint = await findNav(deps.nav, candidate.fundCode, candidate.applicationDate);
          if (!navPoint) {
            blockedPositions.add(positionKey);
            continue;
          }
          if (await confirm(candidate, navPoint)) summary.confirmed++;
        } catch (error) {
          blockedPositions.add(positionKey);
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
  options: {
    intervalMs?: number;
    runMinutes?: number | readonly number[];
    autoStart?: boolean;
  } = {},
): SettlementScheduler {
  const intervalMs = options.intervalMs ?? SCHEDULER_INTERVAL_MS;
  const runMinutes = [
    ...(Array.isArray(options.runMinutes)
      ? options.runMinutes
      : options.runMinutes === undefined
        ? DEFAULT_SETTLEMENT_RUN_MINUTES
        : [options.runMinutes]),
  ].sort((a, b) => a - b);
  let currentDate: string | null = null;
  const handledRounds = new Set<string>();
  let stopped = false;
  const active = new Set<Promise<void>>();
  const runTick = async (): Promise<void> => {
    if (stopped) return;
    const now = deps.clock.now();
    const date = shanghaiDate(now);
    const minutes = shanghaiMinutesOfDay(now);
    if (date !== currentDate) {
      currentDate = date;
      for (const key of handledRounds) {
        if (!key.startsWith(`${date}:`)) handledRounds.delete(key);
      }
      // Starting after a round does not backfill that round. Later rounds still run.
      for (const round of runMinutes) {
        if (round < minutes) handledRounds.add(`${date}:${round}`);
      }
    }
    if (!deps.calendar.isTradingDay(now)) return;
    const round = runMinutes.find(
      (candidate) => candidate <= minutes && !handledRounds.has(`${date}:${candidate}`),
    );
    if (round !== undefined) {
      handledRounds.add(`${date}:${round}`);
      try {
        const summary = await job.run();
        console.log(
          '[bafang-core] trade settlement',
          JSON.stringify({ round: `${date} ${formatMinutes(round)}`, ...summary }),
        );
      } catch (error) {
        console.error('[bafang-core] trade settlement failed', error);
      }
    }
  };
  const tick = (): Promise<void> => {
    const work = runTick();
    active.add(work);
    void work.then(
      () => active.delete(work),
      () => active.delete(work),
    );
    return work;
  };
  const timer = setInterval(() => void tick(), intervalMs);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    return Promise.all([...active]).then(() => undefined);
  };
  const scheduler = Object.assign(stop, { stop, tick }) as SettlementScheduler;
  if (options.autoStart !== false) void tick();
  return scheduler;
}

function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
