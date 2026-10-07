import { z } from 'zod';
import { PROTOCOL_VERSION } from './version';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('duplex-worker'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.enum(['not_found', 'invalid_room_id', 'not_implemented']),
  message: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
