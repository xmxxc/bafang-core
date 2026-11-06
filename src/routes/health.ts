import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema } from '../errors';

export const HealthResponseSchema = z
  .object({
    status: z.literal('ok'),
    database: z.object({
      connected: z.boolean(),
    }),
    time: z.string().openapi({ format: 'date-time' }),
  })
  .openapi('Health');

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['health'],
  summary: '健康检查',
  description: '返回服务存活状态与数据库连通性。',
  responses: {
    200: {
      description: '服务存活，数据库可达',
      content: { 'application/json': { schema: HealthResponseSchema } },
    },
    500: {
      description: '内部错误',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    503: {
      description: '数据库不可达',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});
