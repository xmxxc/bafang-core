import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createDb, createHealthProbe, createPool } from './db';
import { loadConfig, toDbConfig } from './config';
import { loadHongKongTradingCalendar, loadTradingCalendar } from './trading-calendar';
import { createMailer } from './auth/mailer';
import { createGitHubLogin } from './auth/github';
import { createWeChatLogin } from './auth/wechat';

const config = loadConfig();
const pool = createPool(toDbConfig(config));
const app = createApp({
  db: createHealthProbe(pool),
  database: createDb(pool),
  mailer: createMailer(config),
  github: createGitHubLogin(config),
  wechat: createWeChatLogin(config),
  bindCodeSecret: config.BIND_CODE_SECRET,
  tradingCalendar: await loadTradingCalendar(pool),
  hkTradingCalendar: await loadHongKongTradingCalendar(pool),
});

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`bafang-core listening on http://localhost:${info.port}`);
});
