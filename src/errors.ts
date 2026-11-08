import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'database_unavailable',
  'not_found',
  'internal_error',
  'validation_error',
  'fund_not_found',
  'upstream_unavailable',
  'rate_limited',
  'unauthorized',
  'wechat_not_configured',
  'wechat_code_invalid',
  'wechat_unavailable',
  'github_not_configured',
  'github_state_invalid',
  'github_authorization_failed',
  'github_unavailable',
  'verification_code_expired',
  'verification_code_invalid',
  'verification_code_used',
  'verification_code_max_attempts',
  'email_code_cooldown',
  'email_code_daily_limit',
  'channel_name_conflict',
  'channel_protected',
  'channel_has_positions',
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
