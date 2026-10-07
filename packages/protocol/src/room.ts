import { z } from 'zod';

const ROOM_ID_BYTES = 16;

/** base64url without padding: 16 random bytes encode to exactly 22 characters. */
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Room IDs are opaque, 128-bit random tokens. They carry no ordering or meaning. */
export const roomIdSchema = z.string().regex(ROOM_ID_PATTERN, 'Invalid room id');
export type RoomId = z.infer<typeof roomIdSchema>;

/** Generate a cryptographically strong room ID using the platform CSPRNG. */
export function createRoomId(): RoomId {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_ID_BYTES));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
