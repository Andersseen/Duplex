import { z } from 'zod';
import { controlMessageSchema } from './control';
import { signalingMessageSchema } from './signaling';

/** Any message that may travel over a Duplex room connection. */
export const duplexMessageSchema = z.union([signalingMessageSchema, controlMessageSchema]);
export type DuplexMessage = z.infer<typeof duplexMessageSchema>;

/** Parse untrusted input. Returns a result instead of throwing. */
export function parseDuplexMessage(input: unknown) {
  return duplexMessageSchema.safeParse(input);
}
