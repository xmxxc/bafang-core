import { createDb, createPool } from '../db';
import { loadConfig, toDbConfig } from '../config';
import { SystemClock } from '../clock';
import { createNavService } from '../market/nav';
import { HttpUpstreamFetcher } from '../market/upstream';
import { loadTradingCalendar } from '../trading-calendar';
import { createSettlementJob } from './settlement';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(toDbConfig(config));
  try {
    const clock = new SystemClock();
    const calendar = await loadTradingCalendar(pool);
    const nav = createNavService({ upstream: new HttpUpstreamFetcher(), clock, calendar });
    const summary = await createSettlementJob({ db: createDb(pool), nav, clock }).run();
    console.log(JSON.stringify(summary));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
