import type { Clock } from '../clock';
import { UPSTREAM_SOURCES, type UpstreamFetcher, type UpstreamSource } from './upstream';

/**
 * 进程内记录各行情上游最近一次成功的时间，供健康检查报告。
 * 只记上游名与时间，不记地址、参数或响应内容；进程重启后清空。
 */
export class UpstreamHealth {
  private readonly lastSuccess = new Map<UpstreamSource, Date>();

  constructor(private readonly clock: Clock) {}

  record(source: UpstreamSource): void {
    this.lastSuccess.set(source, this.clock.now());
  }

  /** 每个上游一项；从未成功过的为 null。 */
  snapshot(): Record<UpstreamSource, { lastSuccessAt: string | null }> {
    return Object.fromEntries(
      UPSTREAM_SOURCES.map((source) => [
        source,
        { lastSuccessAt: this.lastSuccess.get(source)?.toISOString() ?? null },
      ]),
    ) as Record<UpstreamSource, { lastSuccessAt: string | null }>;
  }
}

/** 包装上游抓取适配器：请求原样转发，来源报告的成功记入 health。 */
export function trackUpstreamHealth(
  inner: UpstreamFetcher,
  health: UpstreamHealth,
): UpstreamFetcher {
  return {
    fetchText: (request) => inner.fetchText(request),
    recordSuccess: (source) => {
      health.record(source);
      inner.recordSuccess?.(source);
    },
  };
}
