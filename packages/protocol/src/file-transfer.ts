import { z } from 'zod';
import {
  FILE_TRANSFER_PROTOCOL_VERSION,
  MAX_FILE_TRANSFER_BYTES,
  MAX_TRANSFER_FILENAME_LENGTH,
} from './version';

const transferIdSchema = z.uuid();
const controlBase = {
  transferId: transferIdSchema,
  protocolVersion: z.literal(FILE_TRANSFER_PROTOCOL_VERSION),
};
const fileOfferSchema = z
  .object({
    type: z.literal('file-offer'),
    transferId: controlBase.transferId,
    protocolVersion: controlBase.protocolVersion,
    name: z.string().min(1).max(MAX_TRANSFER_FILENAME_LENGTH),
    size: z.number().int().nonnegative().max(MAX_FILE_TRANSFER_BYTES),
    mimeType: z.string().max(128),
  })
  .strict();

export const fileTransferMessageSchema = z.discriminatedUnion('type', [
  fileOfferSchema,
  z.object({ type: z.literal('file-accept'), ...controlBase }).strict(),
  z.object({ type: z.literal('file-reject'), ...controlBase }).strict(),
  z.object({ type: z.literal('file-cancel'), ...controlBase }).strict(),
  z.object({ type: z.literal('file-complete'), ...controlBase }).strict(),
  z
    .object({
      type: z.literal('file-error'),
      ...controlBase,
      reason: z.enum(['invalid', 'transfer-failed']),
    })
    .strict(),
]);

export type FileTransferMessage = z.infer<typeof fileTransferMessageSchema>;
