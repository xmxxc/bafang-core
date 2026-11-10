import { serve } from '@hono/node-server';
import { loadConfig, toDbConfig } from '../../../src/config';
import { createPool } from '../../../src/db';
import { startSettlementScheduler } from '../../../src/positions/settlement';
import { installShutdownHandlers } from '../../../src/shutdown';

const config = loadConfig();
const pool = createPool(toDbConfig(config));
const scheduler = startSettlementScheduler(
  {
    async run() {
      console.log('settlement started');
      await pool.query('SELECT pg_advisory_lock(64002)');
      await pool.query('SELECT 1');
      console.log('settlement finished');
      return { confirmed: 1, pending: 0, failed: 0, failures: [] };
    },
  },
  {
    clock: { now: () => new Date('2026-11-09T13:30:00Z') },
    calendar: { isTradingDay: () => true },
  },
  { intervalMs: 10 },
);
const server = serve(
  {
    port: config.PORT,
    async fetch() {
      console.log('request started');
      await pool.query('SELECT pg_advisory_lock(64001)');
      await pool.query('SELECT 1');
      console.log('request finished');
      return new Response('finished');
    },
  },
  () => console.log('listening'),
);
installShutdownHandlers(
  server,
  scheduler,
  {
    async end() {
      await pool.end();
      if (process.env.FAIL_CLOSE) throw new Error('injected close failure');
    },
  },
  process.env.SHORT_DEADLINE ? 300 : 30_000,
);
