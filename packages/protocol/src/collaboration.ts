import { z } from 'zod';

export const COLLABORATION_PROTOCOL_VERSION = 1;
export const MAX_COLLABORATION_BATCH_POINTS = 48;
export const MAX_COLLABORATION_POINTS_PER_STROKE = 4096;
export const MAX_COLLABORATION_STROKES_PER_SURFACE = 128;
export const MAX_COLLABORATION_POINTS_PER_SURFACE = 32_768;

const uuidSchema = z.uuid();
const pointSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .strict();
const base = { protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION) };

const mediaStateSchema = z
  .object({
    type: z.literal('media-state'),
    ...base,
    videoSource: z.enum(['none', 'camera', 'screen']),
    surfaceId: uuidSchema.nullable(),
  })
  .strict()
  .refine(
    (message) =>
      (message.videoSource === 'screen' && message.surfaceId !== null) ||
      (message.videoSource !== 'screen' && message.surfaceId === null),
  );

export const collaborationMessageSchema = z.discriminatedUnion('type', [
  mediaStateSchema,
  z
    .object({
      type: z.literal('stroke-start'),
      ...base,
      surfaceId: uuidSchema,
      strokeId: uuidSchema,
      point: pointSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('stroke-points'),
      ...base,
      surfaceId: uuidSchema,
      strokeId: uuidSchema,
      points: z.array(pointSchema).min(1).max(MAX_COLLABORATION_BATCH_POINTS),
    })
    .strict(),
  z
    .object({
      type: z.literal('stroke-end'),
      ...base,
      surfaceId: uuidSchema,
      strokeId: uuidSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('annotations-clear'),
      ...base,
      surfaceId: uuidSchema,
    })
    .strict(),
]);

export const pointerMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('pointer'),
      ...base,
      surfaceId: uuidSchema,
      mode: z.enum(['pointer', 'laser']),
      ...pointSchema.shape,
      sequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('pointer-hide'),
      ...base,
      surfaceId: uuidSchema,
      sequence: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type CollaborationMessage = z.infer<typeof collaborationMessageSchema>;
export type PointerMessage = z.infer<typeof pointerMessageSchema>;
