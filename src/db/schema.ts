import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 交易日历的特殊日期（按市场、按年导入）：`market` 为 `cn`（A 股）或 `hk`（港股）。
 * `early_close` 为空表示全天休市；有值（`HH:MM`，Asia/Shanghai）表示当天是半日市，在该时刻收市。
 * 只记录落在工作日的日期，周末由交易日历自行判定，因此这里不会出现周六、周日。
 * `date` 用 YYYY-MM-DD 字符串表示。加入 `market` 之前导入的数据都是 A 股，迁移时默认归为 `cn`。
 */
export const tradingHolidays = pgTable(
  'trading_holidays',
  {
    market: text('market').notNull().default('cn'),
    date: date('date', { mode: 'string' }).notNull(),
    name: text('name').notNull(),
    earlyClose: text('early_close'),
  },
  (table) => [primaryKey({ columns: [table.market, table.date] })],
);

/** 使用八方来财的一个人；持仓、自选和设置都归属于用户。 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 用户证明自己身份的一种途径（微信、邮箱、GitHub）。类型与外部标识的组合全局唯一，
 * 每个用户每种类型最多一个。
 */
export const loginMethods = pgTable(
  'login_methods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    externalId: text('external_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('login_methods_type_external_uidx').on(t.type, t.externalId),
    uniqueIndex('login_methods_user_type_uidx').on(t.userId, t.type),
  ],
);

/**
 * 服务端生成的不透明会话令牌，数据库只存哈希。按设备区分（网页 Cookie / 小程序请求头），
 * 退出只作废当前会话。
 */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  device: text('device').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/** 网页端生成、在小程序端消费的一次性绑定码；数据库只存带服务端密钥的哈希。 */
export const bindCodes = pgTable(
  'bind_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bind_codes_code_hash_uidx').on(t.codeHash),
    index('bind_codes_user_created_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * 邮箱验证码：6 位，10 分钟过期，最多输错 5 次，使用一次后失效。
 * `code_hash` 存的是无盐 sha256：对 6 位数字码来说，泄露库仍可枚举反查（10⁶ 种），
 * 并不能像会话令牌那样提供真正的不可逆性；安全主要靠 10 分钟过期、一次性、新码作废旧码兜底。
 */
export const emailVerificationCodes = pgTable(
  'email_verification_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    purpose: text('purpose').notNull().default('login'),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_verification_codes_email_created_idx').on(t.email, t.createdAt)],
);

/**
 * 用户购买基金的平台（支付宝、天天基金、某家银行等）。同一用户下名称唯一，
 * 新用户首次登录时预置"支付宝""天天基金""未指定"三个渠道。
 */
export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('channels_user_idx').on(t.userId),
    uniqueIndex('channels_user_name_uidx').on(t.userId, t.name),
  ],
);

/** 用户在某渠道持有某基金的一笔建仓快照。金额与份额使用定点小数。 */
export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 不级联：渠道删除规则在服务层判断，外键兜底，避免删除渠道时连带删掉持仓。
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    fundCode: text('fund_code').notNull(),
    shares: numeric('shares', { precision: 24, scale: 4 }).notNull(),
    totalCost: numeric('total_cost', { precision: 24, scale: 2 }).notNull(),
    snapshotDate: date('snapshot_date', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('positions_user_channel_idx').on(t.userId, t.channelId),
    uniqueIndex('positions_user_fund_channel_uidx').on(t.userId, t.fundCode, t.channelId),
  ],
);

/** 交易类型预留减仓及成对调仓；本票仅创建加仓。 */
export const tradeType = pgEnum('trade_type', ['buy', 'sell', 'switch_out', 'switch_in']);
export const tradeStatus = pgEnum('trade_status', ['pending', 'confirmed']);

/** 交易保存提交时的日期推算结果；确认前不更改持仓快照。撤销即删除。 */
export const trades = pgTable(
  'trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    type: tradeType('type').notNull(),
    status: tradeStatus('status').notNull().default('pending'),
    submittedDate: date('submitted_date', { mode: 'string' }).notNull(),
    beforeCutoff: boolean('before_cutoff').notNull(),
    applicationDate: date('application_date', { mode: 'string' }).notNull(),
    settlementDate: date('settlement_date', { mode: 'string' }).notNull(),
    // 加仓按金额，减仓按份额；确认任务可回填另一项及确认结果。
    amount: numeric('amount', { precision: 24, scale: 2 }),
    shares: numeric('shares', { precision: 24, scale: 4 }),
    // 比值（0.0015 = 0.15%），最多 6 位小数，HTTP 限制为 0–1。
    feeRate: numeric('fee_rate', { precision: 9, scale: 6 }).notNull(),
    confirmedNav: numeric('confirmed_nav', { precision: 24, scale: 4 }),
    confirmedShares: numeric('confirmed_shares', { precision: 24, scale: 4 }),
    switchId: uuid('switch_id'),
    // 不限长度，后续可保存访问令牌名。
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('trades_position_created_idx').on(t.positionId, t.createdAt, t.id),
    index('trades_status_settlement_idx').on(t.status, t.settlementDate),
    index('trades_switch_idx').on(t.switchId),
  ],
);

/** GitHub 一次性授权请求；state 与浏览器标识只存哈希，10 分钟过期。 */
export const githubOAuthStates = pgTable(
  'github_oauth_states',
  {
    stateHash: text('state_hash').primaryKey(),
    browserHash: text('browser_hash').notNull(),
    verifier: text('verifier').notNull(),
    purpose: text('purpose').notNull().default('login'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('github_oauth_states_expires_idx').on(t.expiresAt)],
);
