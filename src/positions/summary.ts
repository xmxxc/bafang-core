import { divide, fixedFromDb, formatFixed, rescale, type Fixed } from './decimal';
import type { PositionView } from './service';

export interface PositionSummary {
  totalAssets: string | null;
  totalCost: string;
  holdingGain: string | null;
  holdingGainRate: string | null;
  realizedGain: string;
  totalGain: string | null;
  todayGain: string | null;
  todayGainRate: string | null;
  todayGainStatus: PositionView['todayGainStatus'] | 'mixed' | 'none';
  todayGainDate: string;
  previousMarketValue: string | null;
  valuationComplete: boolean;
  todayGainComplete: boolean;
  isComplete: boolean;
}

export interface FundPositionSummary extends PositionSummary {
  fundCode: string;
  shares: string;
  unitPrice: string | null;
}

function sum(values: string[], scale: number): Fixed {
  return {
    value: values.reduce((total, value) => total + fixedFromDb(value, scale).value, 0n),
    scale,
  };
}

/** 金额按持仓已舍入的值相加；收益率按被计入部分的分母重新计算。 */
export function summarizePositions(items: PositionView[], date: string): PositionSummary {
  const valued = items.filter((item) => item.marketValue !== null);
  const gains = items.filter((item) => item.todayGain !== null);
  const assets = sum(
    valued.map((item) => item.marketValue!),
    2,
  );
  const holding = sum(
    valued.map((item) => item.holdingGain!),
    2,
  );
  const valuedCost = sum(
    valued.map((item) => item.totalCost),
    2,
  );
  const todayGain = sum(
    gains.map((item) => item.todayGain!),
    2,
  );
  const previousValue = sum(
    gains.map((item) => item.previousMarketValue!),
    8,
  );
  const statuses = new Set(gains.map((item) => item.todayGainStatus));
  const valuationComplete = valued.length === items.length;
  const todayGainComplete = gains.length === items.length;
  const realized = sum(
    items.map((item) => item.realizedGain),
    2,
  );
  // 有持仓但一笔可用数据也没有时返回 null；没有持仓的金额合计是确定的 0。
  const hasValuation = valued.length > 0 || items.length === 0;
  const hasGain = gains.length > 0 || items.length === 0;
  return {
    totalAssets: hasValuation ? formatFixed(assets) : null,
    totalCost: formatFixed(
      sum(
        items.map((item) => item.totalCost),
        2,
      ),
    ),
    holdingGain: hasValuation ? formatFixed(holding) : null,
    holdingGainRate: valuedCost.value === 0n ? null : formatFixed(divide(holding, valuedCost, 4)),
    realizedGain: formatFixed(realized),
    totalGain: hasValuation
      ? formatFixed({ value: holding.value + realized.value, scale: 2 })
      : null,
    todayGain: hasGain ? formatFixed(todayGain) : null,
    todayGainRate:
      previousValue.value === 0n ? null : formatFixed(divide(todayGain, previousValue, 4)),
    todayGainStatus:
      items.length === 0
        ? 'none'
        : statuses.size > 1
          ? 'mixed'
          : (gains[0]?.todayGainStatus ?? 'unavailable'),
    todayGainDate: date,
    // Keep the full-precision denominator above for the aggregate rate, but expose amounts at 2 decimals.
    previousMarketValue: hasGain ? formatFixed(rescale(previousValue, 2)) : null,
    valuationComplete,
    todayGainComplete,
    isComplete: valuationComplete && todayGainComplete,
  };
}

/** 按第一次出现的顺序返回基金；同基金跨渠道的份额、成本、金额相加，单价与收益率重算。 */
export function summarizeByFund(items: PositionView[], date: string): FundPositionSummary[] {
  const groups = new Map<string, PositionView[]>();
  for (const item of items) {
    const group = groups.get(item.fundCode) ?? [];
    group.push(item);
    groups.set(item.fundCode, group);
  }
  return [...groups].map(([fundCode, group]) => {
    const shares = sum(
      group.map((item) => item.shares),
      4,
    );
    const cost = sum(
      group.map((item) => item.totalCost),
      2,
    );
    return {
      fundCode,
      shares: formatFixed(shares),
      unitPrice: shares.value === 0n ? null : formatFixed(divide(cost, shares, 4)),
      ...summarizePositions(group, date),
    };
  });
}
