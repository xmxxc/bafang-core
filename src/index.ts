import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createDb, createHealthProbe, createPool } from './db';
import { loadConfig, parseSettlementRunMinutes, toDbConfig } from './config';
import { loadHongKongTradingCalendar, loadTradingCalendar } from './trading-calendar';
import { createMailer } from './auth/mailer';
import { createGitHubLogin } from './auth/github';
import { createWeChatQrCode } from './auth/wechat-qr';
import { createWeChatLogin } from './auth/wechat';
import { startSettlementScheduler } from './positions/settlement';

const config = loadConfig();
const pool = createPool(toDbConfig(config));
const tradingCalendar = await loadTradingCalendar(pool);
const app = createApp({
  db: createHealthProbe(pool),
  database: createDb(pool),
  mailer: createMailer(config),
  github: createGitHubLogin(config),
  wechat: createWeChatLogin(config),
  wechatQr: createWeChatQrCode(config),
  qrTicketTtlMs: config.WECHAT_QR_TTL_SECONDS * 1000,
  bindCodeSecret: config.BIND_CODE_SECRET,
  tradingCalendar,
  hkTradingCalendar: await loadHongKongTradingCalendar(pool),
});

const stopSettlementScheduler = app.settlementJob
  ? startSettlementScheduler(
      app.settlementJob,
      {
        clock: { now: () => new Date() },
        calendar: tradingCalendar,
      },
      { runMinutes: parseSettlementRunMinutes(config.SETTLEMENT_ROUNDS) },
    )
  : () => undefined;

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`bafang-core listening on http://localhost:${info.port}`);
});

process.once('SIGTERM', () => {
  stopSettlementScheduler();
  void pool.end();
});
process.once('SIGINT', () => {
  stopSettlementScheduler();
  void pool.end();
});
