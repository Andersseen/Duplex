/**
 * Wire protocol version. Bump on any breaking change to a message schema so that
 * a peer running an older client can be rejected explicitly instead of misparsing.
 */
export const PROTOCOL_VERSION = 4;

/** File-transfer control messages sent over the peer DataChannel. */
export const FILE_TRANSFER_PROTOCOL_VERSION = 1;
export const MAX_FILE_TRANSFER_BYTES = 256 * 1024 * 1024;
export const MAX_TRANSFER_FILENAME_LENGTH = 255;

/** A room holds at most two participants: Duplex is 1:1 by design. */
export const MAX_ROOM_PARTICIPANTS = 2;
