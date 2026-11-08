import { and, eq, max } from 'drizzle-orm';
import type { Db } from '../db';
import { channels, users } from '../db/schema';
import type { ErrorCode } from '../errors';

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * #16 接入持仓表后，在当前事务里按 userId + channelId 查询是否存在任何持仓。
 * 当前尚无持仓表，所有渠道均无持仓；后续已清仓持仓的迁移规则由 #19 补全。
 */
async function channelHasPositions(
  _tx: Transaction,
  _userId: string,
  _channelId: string,
): Promise<boolean> {
  void [_tx, _userId, _channelId];
  return false;
}

async function editableChannel(tx: Transaction, userId: string, id: string) {
  const [channel] = await tx
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .where(and(eq(channels.userId, userId), eq(channels.id, id)));
  if (!channel) throw new ChannelError('not_found', '渠道不存在', 404);
  if (channel.name === '未指定') {
    throw new ChannelError('channel_protected', '“未指定”渠道不能改名或删除', 409);
  }
  return channel;
}

export class ChannelError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

// Drizzle 包装了 pg 错误；只映射渠道名称唯一约束，其他数据库错误继续上抛。
function rethrowNameConflict(error: unknown): never {
  let cause = error;
  while (cause && typeof cause === 'object') {
    if (
      'code' in cause &&
      cause.code === '23505' &&
      'constraint' in cause &&
      cause.constraint === 'channels_user_name_uidx'
    ) {
      throw new ChannelError('channel_name_conflict', '已有同名渠道', 409);
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  throw error;
}

export function createChannelService(db: Db) {
  async function mutate<T>(userId: string, action: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await db.transaction(async (tx) => {
        // 渠道写操作统一锁用户行，使新增末尾位置与排序、删除串行化。
        await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
        return action(tx);
      });
    } catch (error) {
      rethrowNameConflict(error);
    }
  }

  return {
    async list(userId: string) {
      return db
        .select({ id: channels.id, name: channels.name })
        .from(channels)
        .where(eq(channels.userId, userId))
        .orderBy(channels.sortOrder, channels.createdAt, channels.id);
    },
    async create(userId: string, name: string) {
      return mutate(userId, async (tx) => {
        const [last] = await tx
          .select({ order: max(channels.sortOrder) })
          .from(channels)
          .where(eq(channels.userId, userId));
        const [created] = await tx
          .insert(channels)
          .values({ userId, name, sortOrder: (last?.order ?? -1) + 1 })
          .returning({ id: channels.id, name: channels.name });
        if (!created) throw new Error('创建渠道失败');
        return created;
      });
    },
    async rename(userId: string, id: string, name: string) {
      return mutate(userId, async (tx) => {
        await editableChannel(tx, userId, id);
        const [renamed] = await tx
          .update(channels)
          .set({ name })
          .where(and(eq(channels.userId, userId), eq(channels.id, id)))
          .returning({ id: channels.id, name: channels.name });
        if (!renamed) throw new ChannelError('not_found', '渠道不存在', 404);
        return renamed;
      });
    },
    async delete(userId: string, id: string) {
      return mutate(userId, async (tx) => {
        await editableChannel(tx, userId, id);
        if (await channelHasPositions(tx, userId, id)) {
          throw new ChannelError('channel_has_positions', '渠道下仍有持仓，不能删除', 409);
        }
        await tx.delete(channels).where(and(eq(channels.userId, userId), eq(channels.id, id)));
      });
    },
    async reorder(userId: string, channelIds: string[]) {
      return mutate(userId, async (tx) => {
        const current = await tx
          .select({ id: channels.id, name: channels.name })
          .from(channels)
          .where(eq(channels.userId, userId));
        const byId = new Map(current.map((channel) => [channel.id, channel]));
        if (channelIds.some((id) => !byId.has(id))) {
          throw new ChannelError('not_found', '渠道不存在', 404);
        }
        if (channelIds.length !== current.length || new Set(channelIds).size !== current.length) {
          throw new ChannelError('validation_error', '请按顺序提供全部渠道，每个渠道恰好一次', 400);
        }
        const ordered = [];
        for (const [sortOrder, id] of channelIds.entries()) {
          await tx
            .update(channels)
            .set({ sortOrder })
            .where(and(eq(channels.userId, userId), eq(channels.id, id)));
          ordered.push(byId.get(id)!);
        }
        return ordered;
      });
    },
  };
}
