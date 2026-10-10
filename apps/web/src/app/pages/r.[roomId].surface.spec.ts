import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { createRoomId } from '@duplex/protocol';
import { TestBed } from '@angular/core/testing';
import { fireEvent, screen } from '@testing-library/angular';
import { CallSessionService } from '../services/call-session.service';
import RoomPage from './r.[roomId].page';

type Tool = 'off' | 'pointer' | 'laser' | 'draw';

/**
 * The surface handlers decide what is sent to the peer (annotations) or to the controlled browser
 * (remote input). A fake session lets the tests assert exactly those calls without a real call.
 */
function fakeSession() {
  return {
    state: signal('connected'),
    connectionPath: signal('direct'),
    sessionError: signal<string | null>(null),
    cameraError: signal<string | null>(null),
    screenError: signal<string | null>(null),
    roomUrl: signal('https://duplex.test/r/x'),
    muted: signal(false),
    cameraEnabled: signal(false),
    screenSharing: signal(false),
    fileChannelOpen: signal(false),
    helperConnected: signal(false),
    helperPairingCode: signal<string | null>(null),
    remoteVideoStream: signal<MediaStream | null>(null),
    localVideoStream: signal<MediaStream | null>(null),
    remoteAudioStream: signal<MediaStream | null>(null),
    fileTransfers: { transfers: signal([]) },
    collaboration: {
      peerVideoSource: signal<'screen' | 'camera' | null>('screen'),
      localVideoSource: signal<'screen' | 'camera' | null>(null),
      surfaceActive: signal(true),
      surfaceRevision: signal(0),
      strokes: signal<{ id: string; points: { x: number; y: number }[] }[]>([]),
      remotePointer: signal<{ x: number; y: number; mode: 'pointer' | 'laser' } | null>(null),
      tool: signal<Tool>('off'),
      pointerChannelOpen: signal(true),
      collaborationChannelOpen: signal(true),
      setTool: vi.fn(),
      clearAnnotations: vi.fn(),
      beginStroke: vi.fn(),
      addStrokePoint: vi.fn(),
      finishStroke: vi.fn(),
      sendPointer: vi.fn(),
      sendPointerHide: vi.fn(),
    },
    remoteInput: {
      capturing: signal(false),
      keyboardCapturing: signal(false),
      movePointer: vi.fn(),
      pointerButton: vi.fn(),
      scroll: vi.fn(),
      lastPointer: vi.fn().mockReturnValue({ x: 0.5, y: 0.5 }),
    },
    control: {
      session: signal(null),
      incomingRequest: signal(null),
      canRequest: signal(false),
      state: signal('idle'),
      remainingSeconds: signal(0),
      localAvailableScopes: signal<string[]>([]),
    },
    toggleMute: vi.fn(),
    toggleCamera: vi.fn(),
    toggleScreenSharing: vi.fn(),
    leave: vi.fn(),
    join: vi.fn(),
    copyLink: vi.fn().mockReturnValue('https://duplex.test/r/x'),
  };
}

// The shared screen is 1600x900 and drawn into an 800x450 box at the origin.
const VIDEO = { width: 1600, height: 900, box: { left: 0, top: 0, width: 800, height: 450 } };

async function renderSurface(fake: ReturnType<typeof fakeSession>) {
  fake.remoteVideoStream.set({} as MediaStream);
  // The page provides its own session, so the fake has to replace it at component level.
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  TestBed.overrideComponent(RoomPage, {
    set: { providers: [{ provide: CallSessionService, useValue: fake }] },
  });
  const fixture = TestBed.createComponent(RoomPage);
  fixture.componentRef.setInput('roomId', createRoomId());
  await fixture.whenStable();
  const video = screen.getByLabelText<HTMLVideoElement>('Peer video or shared screen');
  Object.defineProperty(video, 'videoWidth', { value: VIDEO.width, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: VIDEO.height, configurable: true });
  video.getBoundingClientRect = () =>
    ({ ...VIDEO.box, right: 800, bottom: 450, x: 0, y: 0 }) as DOMRect;
  return screen.getByRole('group', { name: 'Shared screen collaboration surface' });
}

function pointer(type: 'pointerDown' | 'pointerMove' | 'pointerUp', target: Element, init = {}) {
  return fireEvent[type](target, { pointerId: 1, pointerType: 'mouse', button: 0, ...init });
}

describe('RoomPage shared-screen surface', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    // jsdom's media elements neither play nor return the promise browsers do.
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    for (const method of ['setPointerCapture', 'releasePointerCapture'] as const)
      Object.defineProperty(Element.prototype, method, { configurable: true, value: vi.fn() });
    Object.defineProperty(Element.prototype, 'hasPointerCapture', {
      configurable: true,
      value: () => true,
    });
  });

  it('records a stroke from pointer down to up when the draw tool is active', async () => {
    const fake = fakeSession();
    fake.collaboration.tool.set('draw');
    const surface = await renderSurface(fake);

    pointer('pointerDown', surface, { clientX: 400, clientY: 225 });
    pointer('pointerMove', surface, { clientX: 600, clientY: 225 });
    pointer('pointerUp', surface, { clientX: 600, clientY: 225 });

    expect(fake.collaboration.beginStroke).toHaveBeenCalledWith({ x: 0.5, y: 0.5 });
    expect(fake.collaboration.addStrokePoint).toHaveBeenCalledWith({ x: 0.75, y: 0.5 });
    expect(fake.collaboration.finishStroke).toHaveBeenCalledOnce();
  });

  it('sends the pointer position once per frame and hides it when the pointer leaves', async () => {
    const fake = fakeSession();
    fake.collaboration.tool.set('laser');
    const surface = await renderSurface(fake);

    pointer('pointerMove', surface, { clientX: 200, clientY: 225 });
    expect(fake.collaboration.sendPointer).toHaveBeenCalledWith('laser', { x: 0.25, y: 0.5 });

    fireEvent.pointerLeave(surface);
    expect(fake.collaboration.sendPointerHide).toHaveBeenCalled();
  });

  it('does not draw or send a pointer while the tool is off', async () => {
    const fake = fakeSession();
    const surface = await renderSurface(fake);

    pointer('pointerDown', surface, { clientX: 400, clientY: 225 });
    pointer('pointerMove', surface, { clientX: 400, clientY: 225 });

    expect(fake.collaboration.beginStroke).not.toHaveBeenCalled();
    expect(fake.collaboration.sendPointer).not.toHaveBeenCalled();
  });

  it('ends an unfinished stroke when the pointer leaves the surface', async () => {
    const fake = fakeSession();
    fake.collaboration.tool.set('draw');
    const surface = await renderSurface(fake);

    pointer('pointerDown', surface, { clientX: 400, clientY: 225 });
    fireEvent.pointerLeave(surface);

    expect(fake.collaboration.finishStroke).toHaveBeenCalledOnce();
  });

  it('renders annotations and the peer pointer over the shared screen', async () => {
    const fake = fakeSession();
    fake.collaboration.strokes.set([
      {
        id: 's1',
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.2, y: 0.2 },
        ],
      },
    ]);
    fake.collaboration.remotePointer.set({ x: 0.3, y: 0.3, mode: 'laser' });
    const surface = await renderSurface(fake);

    expect(surface.querySelector('path')?.getAttribute('d')).toBe('M 0.1 0.1 L 0.2 0.2');
    expect(surface.querySelector('circle')).toHaveAttribute('fill', '#ef4444');
  });

  describe('while controlling the peer', () => {
    it('relays a left click as normalized down and up events and captures the pointer', async () => {
      const fake = fakeSession();
      fake.remoteInput.capturing.set(true);
      const surface = await renderSurface(fake);

      pointer('pointerDown', surface, { clientX: 400, clientY: 225 });
      pointer('pointerMove', surface, { clientX: 400, clientY: 225 });
      pointer('pointerUp', surface, { clientX: 400, clientY: 225 });

      expect(fake.remoteInput.pointerButton).toHaveBeenNthCalledWith(1, 'left', 'down', {
        x: 0.5,
        y: 0.5,
      });
      expect(fake.remoteInput.movePointer).toHaveBeenCalledWith({ x: 0.5, y: 0.5 });
      expect(fake.remoteInput.pointerButton).toHaveBeenNthCalledWith(2, 'left', 'up', {
        x: 0.5,
        y: 0.5,
      });
    });

    it('maps the right button, ignores middle and touch input, and swallows the context menu', async () => {
      const fake = fakeSession();
      fake.remoteInput.capturing.set(true);
      const surface = await renderSurface(fake);

      pointer('pointerDown', surface, { clientX: 400, clientY: 225, button: 1 });
      pointer('pointerDown', surface, { clientX: 400, clientY: 225, pointerType: 'touch' });
      expect(fake.remoteInput.pointerButton).not.toHaveBeenCalled();

      pointer('pointerDown', surface, { clientX: 400, clientY: 225, button: 2 });
      expect(fake.remoteInput.pointerButton).toHaveBeenCalledWith(
        'right',
        'down',
        expect.anything(),
      );
      // Always release: a lost capture must never leave the remote button held.
      fireEvent.lostPointerCapture(surface, { pointerId: 1 });
      expect(fake.remoteInput.pointerButton).toHaveBeenLastCalledWith(
        'right',
        'up',
        expect.anything(),
      );

      expect(fireEvent.contextMenu(surface)).toBe(false);
    });

    it('does not press a button for a click outside the shared video', async () => {
      const fake = fakeSession();
      fake.remoteInput.capturing.set(true);
      const surface = await renderSurface(fake);

      pointer('pointerDown', surface, { clientX: 5000, clientY: 5000 });

      expect(fake.remoteInput.pointerButton).not.toHaveBeenCalled();
    });

    it('relays wheel scrolling over the video and leaves it alone otherwise', async () => {
      const fake = fakeSession();
      fake.remoteInput.capturing.set(true);
      const surface = await renderSurface(fake);

      fireEvent.wheel(surface, { clientX: 400, clientY: 225, deltaY: 100, deltaMode: 0 });
      expect(fake.remoteInput.scroll).toHaveBeenCalledOnce();

      fireEvent.wheel(surface, { clientX: 9000, clientY: 9000, deltaY: 100 });
      expect(fake.remoteInput.scroll).toHaveBeenCalledOnce();
    });

    it('locks the annotation tools while input is captured', async () => {
      const fake = fakeSession();
      fake.remoteInput.capturing.set(true);
      await renderSurface(fake);

      expect(screen.getByRole('button', { name: 'Pointer' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Draw' })).toBeDisabled();
    });
  });

  it('disables tools whose data channel is not open and routes tool changes to the service', async () => {
    const fake = fakeSession();
    fake.collaboration.pointerChannelOpen.set(false);
    await renderSurface(fake);

    expect(screen.getByRole('button', { name: 'Pointer' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Laser' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Draw' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Draw' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(fake.collaboration.setTool).toHaveBeenCalledWith('draw');
    expect(fake.collaboration.clearAnnotations).toHaveBeenCalledOnce();
  });
});
