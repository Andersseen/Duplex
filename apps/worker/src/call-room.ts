import { DurableObject } from 'cloudflare:workers';
import {
  MAX_ROOM_PARTICIPANTS,
  PROTOCOL_VERSION,
  clientSignalingMessageSchema,
  protocolErrorMessageSchema,
  roomFullMessageSchema,
  serverSignalingMessageSchema,
} from '@duplex/protocol';
import type { ServerSignalingMessage } from '@duplex/protocol';
import { z } from 'zod';
import { generateRtcConfiguration } from './rtc-config';

const MAX_MESSAGE_BYTES = 128 * 1024;
const attachmentSchema = z
  .object({
    participantId: z.string().min(16).max(64),
    joined: z.boolean(),
    polite: z.boolean().optional(),
    protocolVersion: z.number().int().positive().optional(),
    lastRtcConfigIssuedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
type ParticipantAttachment = z.infer<typeof attachmentSchema>;

function randomParticipantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function attachment(socket: WebSocket): ParticipantAttachment | null {
  const parsed = attachmentSchema.safeParse(socket.deserializeAttachment());
  return parsed.success ? parsed.data : null;
}

function send(socket: WebSocket, message: ServerSignalingMessage): void {
  const parsed = serverSignalingMessageSchema.safeParse(message);
  if (parsed.success && socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(parsed.data));
}

function sendProtocolError(
  socket: WebSocket,
  code: 'protocol_mismatch' | 'invalid_message' | 'not_joined',
  message: string,
): void {
  send(
    socket,
    protocolErrorMessageSchema.parse({
      type: 'protocol-error',
      payload: {
        code,
        message,
        ...(code === 'protocol_mismatch' ? { expectedVersion: PROTOCOL_VERSION } : {}),
      },
    }),
  );
}

export class CallRoom extends DurableObject {
  static readonly capacity = MAX_ROOM_PARTICIPANTS;

  override fetch(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json(
        { error: 'websocket_required', message: 'This endpoint requires a WebSocket upgrade.' },
        { status: 426, headers: { Upgrade: 'websocket' } },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      participantId: randomParticipantId(),
      joined: false,
    } satisfies ParticipantAttachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const current = attachment(socket);
    if (!current) {
      socket.close(1008, 'Invalid participant attachment');
      return;
    }
    const size =
      typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
    if (size > MAX_MESSAGE_BYTES || typeof data !== 'string') {
      sendProtocolError(socket, 'invalid_message', 'Message is too large or not valid JSON text.');
      socket.close(1009, 'Message too large');
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      sendProtocolError(socket, 'invalid_message', 'Message must contain valid JSON.');
      socket.close(1007, 'Invalid JSON');
      return;
    }
    const parsed = clientSignalingMessageSchema.safeParse(raw);
    if (!parsed.success) {
      sendProtocolError(socket, 'invalid_message', 'Message does not match the Duplex protocol.');
      socket.close(1008, 'Invalid message');
      return;
    }
    const message = parsed.data;

    if (!current.joined) {
      if (message.type !== 'join') {
        sendProtocolError(socket, 'not_joined', 'Join the room before sending messages.');
        socket.close(1008, 'Join required');
        return;
      }
      if (message.payload.protocolVersion !== PROTOCOL_VERSION) {
        sendProtocolError(
          socket,
          'protocol_mismatch',
          'Client and server protocol versions do not match.',
        );
        socket.close(4001, 'Protocol mismatch');
        return;
      }

      const joined = this.participants();
      if (joined.length >= MAX_ROOM_PARTICIPANTS) {
        send(
          socket,
          roomFullMessageSchema.parse({ type: 'room-full', payload: { reason: 'capacity' } }),
        );
        socket.close(4009, 'Room is full');
        return;
      }
      const peerPresent = joined.length > 0;
      const updated = {
        ...current,
        joined: true,
        polite: peerPresent,
        protocolVersion: PROTOCOL_VERSION,
        lastRtcConfigIssuedAt: Date.now(),
      };
      socket.serializeAttachment(updated);
      send(socket, {
        type: 'joined',
        payload: { participantId: updated.participantId, polite: updated.polite, peerPresent },
      });
      await this.sendRtcConfiguration(socket, updated.participantId);
      if (peerPresent) {
        for (const peer of joined) {
          const peerData = attachment(peer);
          if (peerData)
            send(peer, { type: 'peer-joined', payload: { participantId: updated.participantId } });
        }
      }
      return;
    }

    if (message.type === 'join') {
      sendProtocolError(socket, 'invalid_message', 'This participant has already joined.');
      socket.close(1008, 'Already joined');
      return;
    }
    if (message.type === 'leave') {
      this.notifyPeerLeft(socket);
      socket.serializeAttachment({ ...current, joined: false });
      socket.close(1000, 'Participant left');
      return;
    }
    if (message.type === 'refresh-rtc-config') {
      const lastIssuedAt = current.lastRtcConfigIssuedAt ?? 0;
      if (Date.now() - lastIssuedAt < 60_000) return;
      const updated = { ...current, lastRtcConfigIssuedAt: Date.now() };
      socket.serializeAttachment(updated);
      await this.sendRtcConfiguration(socket, updated.participantId);
      return;
    }
    for (const peer of this.participants()) {
      if (peer !== socket) send(peer, message);
    }
  }

  private async sendRtcConfiguration(socket: WebSocket, participantId: string): Promise<void> {
    const config = await generateRtcConfiguration(this.env);
    const message = {
      type: 'rtc-config' as const,
      payload: {
        iceServers: config.iceServers,
        expiresAt: config.expiresAt,
        relayAvailable: config.relayAvailable,
      },
    };
    send(socket, message);
    if (!config.relayAvailable)
      console.warn('Participant received STUN-only configuration.', { participantId });
  }

  override webSocketClose(socket: WebSocket): void {
    this.notifyPeerLeft(socket);
    const current = attachment(socket);
    if (current?.joined) socket.serializeAttachment({ ...current, joined: false });
  }

  override webSocketError(socket: WebSocket): void {
    this.notifyPeerLeft(socket);
    const current = attachment(socket);
    if (current?.joined) socket.serializeAttachment({ ...current, joined: false });
    try {
      socket.close(1011, 'WebSocket error');
    } catch {
      /* Runtime may already have closed it. */
    }
  }

  private participants(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => attachment(socket)?.joined === true);
  }

  private notifyPeerLeft(socket: WebSocket): void {
    if (attachment(socket)?.joined !== true) return;
    for (const peer of this.participants()) {
      if (peer !== socket) send(peer, { type: 'peer-left', payload: {} });
    }
  }
}
