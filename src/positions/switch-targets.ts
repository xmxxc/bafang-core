import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db';
import { positions, switches, trades } from '../db/schema';

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type PositionRow = typeof positions.$inferSelect;

/** When a target position appears after switch submission, bind its pending incoming legs
 * while the user lock is held. All pending/history/clearing/delete paths then share positionId. */
export async function linkPendingSwitchIns(tx: Transaction, position: PositionRow): Promise<void> {
  const pending = await tx
    .select({ tradeId: trades.id })
    .from(trades)
    .innerJoin(switches, eq(switches.id, trades.switchId))
    .innerJoin(positions, eq(positions.id, switches.sourcePositionId))
    .where(
      and(
        eq(trades.type, 'switch_in'),
        eq(trades.status, 'pending'),
        isNull(trades.positionId),
        eq(positions.userId, position.userId),
        eq(positions.channelId, position.channelId),
        eq(switches.targetFundCode, position.fundCode),
      ),
    );
  if (pending.length === 0) return;
  await tx
    .update(trades)
    .set({ positionId: position.id })
    .where(
      inArray(
        trades.id,
        pending.map((row) => row.tradeId),
      ),
    );
}
