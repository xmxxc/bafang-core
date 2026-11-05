import { z } from 'zod';

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ description: '机器可读的错误码' }),
      message: z.string().openapi({ description: '人类可读的说明' }),
    }),
  })
  .openapi('Error');

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export function errorBody(code: string, message: string): ErrorResponse {
  return { error: { code, message } };
}
