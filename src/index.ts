import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createHealthProbe, createPool } from './db';
import { loadConfig, toDbConfig } from './config';
import { ChineseTradingCalendar } from './trading-calendar';
import { loadHolidays } from './trading-calendar/holidays';

const config = loadConfig();
const pool = createPool(toDbConfig(config));
const holidays = await loadHolidays(pool);
const app = createApp({
  db: createHealthProbe(pool),
  tradingCalendar: new ChineseTradingCalendar(holidays),
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`bafang-core listening on http://localhost:${info.port}`);
});
