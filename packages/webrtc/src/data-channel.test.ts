import { describe, expect, it, vi } from 'vitest';
import {
  createDuplexDataChannel,
  DATA_CHANNEL_BUFFERED_AMOUNT_LOW_THRESHOLD,
} from './data-channel';
import type { DuplexDataChannelEvent } from './types';

class FakeChannel {
  label = 'duplex-file-transfer';
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  readonly sent: (string | ArrayBuffer)[] = [];
  closeCalls = 0;
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalls += 1;
    this.readyState = 'closed';
  }
}

function wrap(channel = new FakeChannel()) {
  const wrapped = createDuplexDataChannel(channel as unknown as RTCDataChannel);
  const events: DuplexDataChannelEvent[] = [];
  wrapped.subscribe((event) => events.push(event));
  return { channel, wrapped, events };
}

describe('createDuplexDataChannel', () => {
  it('configures binary transfers and the low-water mark', () => {
    const { channel, wrapped } = wrap();

    expect(channel.binaryType).toBe('arraybuffer');
    expect(wrapped.bufferedAmountLowThreshold).toBe(DATA_CHANNEL_BUFFERED_AMOUNT_LOW_THRESHOLD);
    expect(wrapped.label).toBe('duplex-file-transfer');
  });

  it('refuses to send until the channel is open', () => {
    const { channel, wrapped } = wrap();

    expect(() => {
      wrapped.sendText('hello');
    }).toThrow('not open');
    expect(() => {
      wrapped.sendBinary(new ArrayBuffer(1));
    }).toThrow('not open');

    channel.readyState = 'open';
    wrapped.sendText('hello');
    wrapped.sendBinary(new ArrayBuffer(2));
    expect(channel.sent).toHaveLength(2);
  });

  it('emits open, text, binary and blob messages, and ignores unknown payloads', async () => {
    const { channel, events } = wrap();

    channel.onopen?.();
    channel.onmessage?.(new MessageEvent('message', { data: 'text' }));
    channel.onmessage?.(new MessageEvent('message', { data: new ArrayBuffer(3) }));
    channel.onmessage?.(new MessageEvent('message', { data: new Blob(['abcd']) }));
    channel.onmessage?.(new MessageEvent('message', { data: 42 }));
    await vi.waitFor(() => {
      expect(events).toHaveLength(4);
    });

    expect(events.map((event) => event.type)).toEqual(['open', 'message', 'message', 'message']);
    const blobEvent = events[3];
    expect(blobEvent?.type === 'message' && (blobEvent.data as ArrayBuffer).byteLength).toBe(4);
  });

  it('replays open to late subscribers and supports unsubscribing', () => {
    const channel = new FakeChannel();
    channel.readyState = 'open';
    const { wrapped, events } = wrap(channel);
    expect(events).toEqual([{ type: 'open' }]);

    const late: DuplexDataChannelEvent[] = [];
    const unsubscribe = wrapped.subscribe((event) => late.push(event));
    unsubscribe();
    channel.onclose?.();
    expect(late).toEqual([{ type: 'open' }]);
  });

  it('resolves backpressure waits when the buffer drains or the channel closes', async () => {
    const { channel, wrapped } = wrap();
    channel.bufferedAmount = 1_000_000;

    const drained = wrapped.waitForBufferedAmountLow();
    channel.onbufferedamountlow?.();
    await expect(drained).resolves.toBeUndefined();

    const closed = wrapped.waitForBufferedAmountLow();
    channel.onclose?.();
    await expect(closed).resolves.toBeUndefined();
    await expect(wrapped.waitForBufferedAmountLow()).resolves.toBeUndefined();
  });

  it('does not wait when the buffer is already below the threshold', async () => {
    const { wrapped } = wrap();
    await expect(wrapped.waitForBufferedAmountLow()).resolves.toBeUndefined();
  });

  it('closes an open channel once and ignores a closing or closed one', () => {
    const { channel, wrapped } = wrap();
    channel.readyState = 'closing';
    wrapped.close();
    expect(channel.closeCalls).toBe(0);

    channel.readyState = 'open';
    wrapped.close();
    wrapped.close();
    expect(channel.closeCalls).toBe(1);
    expect(wrapped.state).toBe('closed');
    expect(wrapped.bufferedAmount).toBe(0);
  });
});
