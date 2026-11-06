import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'database_unavailable',
  'not_found',
  'internal_error',
  'validation_error',
  'fund_not_found',
  'upstream_unavailable',
  'rate_limited',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema.openapi({ description: '机器可读的错误码' }),
      message: z.string().openapi({ description: '人类可读的说明' }),
    }),
  })
  .openapi('Error');

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export function errorBody(code: ErrorCode, message: string): ErrorResponse {
  return { error: { code, message } };
}
