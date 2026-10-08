import type { DataChannelLabel, DuplexDataChannel, DuplexDataChannelEvent } from './types';

export const DATA_CHANNEL_BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024;

/** Wraps a browser DataChannel and exposes only the operations Duplex needs. */
export function createDuplexDataChannel(channel: RTCDataChannel): DuplexDataChannel {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = DATA_CHANNEL_BUFFERED_AMOUNT_LOW_THRESHOLD;
  const listeners = new Set<(event: DuplexDataChannelEvent) => void>();
  const lowWaiters = new Set<() => void>();
  let closed = channel.readyState === 'closed';
  const emit = (event: DuplexDataChannelEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const resolveLowWaiters = (): void => {
    for (const resolve of lowWaiters) resolve();
    lowWaiters.clear();
  };
  channel.onopen = () => {
    emit({ type: 'open' });
  };
  channel.onclose = () => {
    closed = true;
    resolveLowWaiters();
    emit({ type: 'close' });
  };
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === 'string') emit({ type: 'message', data: event.data });
    else if (event.data instanceof ArrayBuffer) emit({ type: 'message', data: event.data });
    else if (event.data instanceof Blob)
      void event.data.arrayBuffer().then((data) => {
        emit({ type: 'message', data });
      });
  };
  channel.onbufferedamountlow = () => {
    resolveLowWaiters();
  };
  return {
    label: channel.label as DataChannelLabel,
    get state() {
      return channel.readyState;
    },
    get bufferedAmount() {
      return channel.bufferedAmount;
    },
    get bufferedAmountLowThreshold() {
      return channel.bufferedAmountLowThreshold;
    },
    sendText(data): void {
      if (channel.readyState !== 'open') throw new Error('DataChannel is not open.');
      channel.send(data);
    },
    sendBinary(data): void {
      if (channel.readyState !== 'open') throw new Error('DataChannel is not open.');
      channel.send(data);
    },
    waitForBufferedAmountLow(): Promise<void> {
      if (
        closed ||
        channel.readyState === 'closed' ||
        channel.bufferedAmount <= channel.bufferedAmountLowThreshold
      )
        return Promise.resolve();
      return new Promise((resolve) => lowWaiters.add(resolve));
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      if (channel.readyState === 'open') listener({ type: 'open' });
      return () => listeners.delete(listener);
    },
    close(): void {
      if (channel.readyState === 'closed' || channel.readyState === 'closing') return;
      channel.close();
    },
  };
}
