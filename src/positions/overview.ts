import type { Clock } from '../clock';
import { shanghaiDate } from '../clock';
import type { createChannelService } from '../channels/service';
import type { FundService } from '../market/funds';
import type { IndexService } from '../market/indices';
import { fixedFromDb } from './decimal';
import type { PositionService } from './service';
import { summarizePositions } from './summary';

export async function todayOverview(
  deps: {
    positions: PositionService;
    channels: ReturnType<typeof createChannelService>;
    funds: FundService;
    indices: IndexService;
    clock: Clock;
  },
  userId: string,
  channelId?: string,
) {
  // 先校验渠道归属；失败请求不再请求无关的行情。
  const all = await deps.positions.listWithQuotes(userId, channelId, true);
  const visible = all.filter((item) => !item.isCleared);
  const [channels, funds, indices] = await Promise.all([
    deps.channels.list(userId),
    Promise.all(
      [...new Set(visible.map((item) => item.fundCode))].map(async (code) => {
        const fund = await deps.funds.get(code).catch(() => null);
        return [code, fund?.name ?? null] as const;
      }),
    ),
    deps.indices.list(),
  ]);
  const channelNames = new Map(channels.map((channel) => [channel.id, channel.name]));
  const fundNames = new Map(funds);
  const heldFunds = new Map(
    visible
      .filter((item) => fixedFromDb(item.shares, 4).value > 0n)
      .map((item) => [item.fundCode, item.quote.direction]),
  );
  const changes = [...heldFunds.values()];
  const time = deps.clock.now();
  return {
    summary: {
      ...summarizePositions(all, all[0]?.todayGainDate ?? shanghaiDate(time)),
      risingCount: changes.filter((change) => change === 'up').length,
      fallingCount: changes.filter((change) => change === 'down').length,
    },
    positions: visible.map((item) => ({
      ...item,
      fundName: fundNames.get(item.fundCode) ?? null,
      channelName: channelNames.get(item.channelId) ?? null,
    })),
    indices: { items: indices, time: time.toISOString() },
    time: time.toISOString(),
    referenceOnly: true as const,
  };
}
