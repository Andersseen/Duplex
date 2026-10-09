import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  viewChild,
  computed,
  input,
} from '@angular/core';
import type { ElementRef, OnDestroy } from '@angular/core';
import { RouterLink } from '@angular/router';
import { roomIdSchema } from '@duplex/protocol';
import { CallSessionService } from '../services/call-session.service';
import { clientToNormalized, containedVideoRect } from '../collaboration/screen-geometry';
import type { NormalizedPoint } from '../services/collaboration.service';
import { normalizeWheelDelta } from '../services/remote-input.service';
import { EnterMotion, preloadMovement } from '../ui/enter-motion';
import { AssistPanel } from '../room/assist-panel';
import { FileTransferList } from '../room/file-transfer-list';
import { HelperPanel } from '../room/helper-panel';
import { ControlButton } from '../ui/control-button';
import { StatusBadge } from '../ui/status-badge';
import type { StatusTone } from '../ui/status-badge';

@Component({
  selector: 'dx-room-page',
  imports: [
    RouterLink,
    ControlButton,
    StatusBadge,
    HelperPanel,
    AssistPanel,
    FileTransferList,
    EnterMotion,
  ],
  providers: [CallSessionService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-dvh flex-col' },
  template: `
    <header class="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
      <a routerLink="/" class="text-lg font-semibold tracking-tight">Duplex</a>
      @if (isActive()) {
        <div class="flex items-center gap-3">
          @if (showConnectionPath) {
            <span class="hidden text-xs text-ink-muted sm:inline">
              {{ session.connectionPath() }} path
            </span>
          }
          <dx-status-badge [tone]="statusTone()">{{ statusText() }}</dx-status-badge>
        </div>
      }
    </header>

    <main class="flex flex-1 flex-col gap-4 px-4 pb-4 sm:px-6 lg:flex-row">
      <div
        class="flex min-w-0 flex-1 flex-col items-center gap-4"
        [class.justify-center]="!isActive()"
      >
        <section
          class="relative flex min-h-[45vh] w-full max-w-6xl items-center justify-center overflow-hidden rounded-3xl border border-line bg-surface-muted p-3 sm:min-h-[60vh]"
          [class.hidden]="
            !isActive() || (!session.remoteVideoStream() && !session.localVideoStream())
          "
          aria-label="Video call"
        >
          <div
            #videoSurface
            class="relative flex min-h-[40vh] w-full items-center justify-center sm:min-h-[55vh]"
          >
            <video
              #remoteVideo
              autoplay
              playsinline
              [class]="
                !session.remoteVideoStream()
                  ? 'hidden'
                  : session.collaboration.peerVideoSource() === 'screen' ||
                      session.collaboration.localVideoSource() !== 'screen'
                    ? 'max-h-[70vh] w-full object-contain'
                    : pipClasses
              "
              aria-label="Peer video or shared screen"
            ></video>
            <div
              [class.hidden]="session.remoteVideoStream() || session.screenSharing()"
              class="flex min-h-64 items-center justify-center text-ink-muted"
            >
              Your preview
            </div>
            <video
              #localVideo
              autoplay
              muted
              playsinline
              [class]="
                !session.localVideoStream()
                  ? 'hidden'
                  : session.collaboration.localVideoSource() === 'screen' &&
                      session.collaboration.peerVideoSource() !== 'screen'
                    ? 'max-h-[70vh] w-full object-contain'
                    : pipClasses
              "
              aria-label="Your camera or shared screen preview"
            ></video>
            @if (session.collaboration.surfaceActive()) {
              <svg
                class="absolute inset-0 h-full w-full touch-none"
                [attr.viewBox]="overlayViewBox()"
                preserveAspectRatio="none"
                role="img"
                aria-label="Shared screen collaboration surface"
                (pointerdown)="onSurfacePointerDown($event)"
                (pointermove)="onSurfacePointerMove($event)"
                (pointerup)="onSurfacePointerUp($event)"
                (pointercancel)="onSurfacePointerUp($event)"
                (lostpointercapture)="onSurfacePointerUp($event)"
                (pointerleave)="onSurfacePointerLeave()"
                (contextmenu)="onSurfaceContextMenu($event)"
                (wheel)="onSurfaceWheel($event)"
                [class.cursor-crosshair]="session.remoteInput.capturing()"
              >
                <g [attr.transform]="overlayTransform()">
                  @for (stroke of session.collaboration.strokes(); track stroke.id) {
                    <path
                      [attr.d]="strokePath(stroke.points)"
                      fill="none"
                      stroke="#2563eb"
                      stroke-width="0.004"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      vector-effect="non-scaling-stroke"
                      class="pointer-events-none"
                    />
                  }
                  @if (session.collaboration.remotePointer(); as pointer) {
                    <circle
                      [attr.cx]="pointer.x"
                      [attr.cy]="pointer.y"
                      [attr.r]="pointer.mode === 'laser' ? 0.012 : 0.009"
                      [attr.fill]="pointer.mode === 'laser' ? '#ef4444' : '#2563eb'"
                      class="pointer-events-none"
                      [class.animate-pulse]="pointer.mode === 'laser'"
                    />
                  }
                </g>
              </svg>
            }
          </div>
        </section>

        @if (!isValidRoom()) {
          <section class="flex flex-col items-center gap-3 text-center" dxEnter>
            <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">Invalid room link</h1>
            <p class="max-w-prose text-lg text-ink-muted">This link is not a Duplex room.</p>
            <a routerLink="/" class="underline underline-offset-4">Start a new call</a>
          </section>
        } @else if (session.state() === 'ready') {
          <section class="flex flex-col items-center gap-4 text-center" dxEnter>
            <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">Ready to join</h1>
            <p class="text-lg text-ink-muted">Your microphone will turn on when you join.</p>
            <dx-control-button label="Join call" variant="primary" (activated)="join()" />
          </section>
        } @else if (session.state() === 'failed' || session.state() === 'left') {
          <section class="flex flex-col items-center gap-4 text-center">
            <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">
              {{ session.state() === 'left' ? 'You left the call' : 'Could not join the call' }}
            </h1>
            @if (session.sessionError()) {
              <p role="alert" class="max-w-prose text-ink-muted">{{ session.sessionError() }}</p>
            }
            <div class="flex items-center gap-3">
              <dx-control-button
                [label]="session.state() === 'left' ? 'Rejoin call' : 'Try again'"
                variant="primary"
                (activated)="join()"
              />
              <a
                routerLink="/"
                class="inline-flex min-h-11 items-center rounded-full border border-line px-5 py-2.5"
                >Back</a
              >
            </div>
          </section>
        } @else if (session.state() === 'requesting-media' || session.state() === 'joining') {
          <section class="text-center">
            <h1 class="text-3xl font-semibold tracking-tight">
              {{ session.state() === 'joining' ? 'Joining call…' : 'Allow microphone access' }}
            </h1>
            @if (session.sessionError()) {
              <p role="alert">{{ session.sessionError() }}</p>
            }
          </section>
        } @else {
          @if (session.sessionError()) {
            <p role="alert" class="text-sm text-danger">{{ session.sessionError() }}</p>
          }
          <section
            class="flex min-h-[30vh] w-full max-w-4xl flex-col items-center justify-center gap-3 rounded-3xl border border-line bg-surface px-6 text-center"
            [class.hidden]="session.remoteVideoStream() || session.localVideoStream()"
            aria-label="Audio call"
          >
            <h1 class="text-3xl font-semibold tracking-tight">
              {{ session.state() === 'connected' ? 'Connected' : statusText() }}
            </h1>
            <p class="text-ink-muted">
              {{
                session.state() === 'connected'
                  ? 'Audio call · Camera and screen are off.'
                  : 'Share this link with the person you want to talk to.'
              }}
            </p>
          </section>

          @if (session.state() !== 'connected') {
            <div class="flex w-full max-w-4xl flex-wrap items-center justify-center gap-2">
              <label for="room-link" class="text-sm font-medium">Copy this link</label>
              <input
                id="room-link"
                class="w-[min(80vw,32rem)] rounded-lg border border-line bg-transparent px-3 py-2 text-sm"
                readonly
                [value]="session.roomUrl()"
              />
              <dx-control-button
                [label]="copied() ? 'Copied' : 'Copy link'"
                (activated)="copyLink()"
              />
            </div>
          }

          @if (session.collaboration.surfaceActive()) {
            <div
              role="group"
              class="flex flex-wrap justify-center gap-2"
              aria-label="Screen collaboration tools"
            >
              @for (tool of collaborationTools; track tool.id) {
                <dx-control-button
                  [label]="tool.label"
                  [pressed]="session.collaboration.tool() === tool.id"
                  [disabled]="toolDisabled(tool.id)"
                  (activated)="session.collaboration.setTool(tool.id)"
                />
              }
              <dx-control-button
                label="Clear"
                [disabled]="!session.collaboration.collaborationChannelOpen()"
                (activated)="session.collaboration.clearAnnotations()"
              />
            </div>
          }
          @if (session.cameraError()) {
            <p role="alert" class="text-sm text-danger">{{ session.cameraError() }}</p>
          }
          @if (session.screenError()) {
            <p role="alert" class="text-sm text-danger">{{ session.screenError() }}</p>
          }
          @if (session.screenSharing()) {
            <p class="text-sm text-ink-muted">
              Sharing screen. Your camera will resume when sharing stops.
            </p>
          }
        }
      </div>

      @if (isActive() && showTools()) {
        <aside aria-label="Call tools" class="flex flex-col gap-4 lg:w-80 lg:shrink-0" dxEnter>
          @if (session.screenSharing()) {
            <dx-helper-panel />
          }
          @if (session.collaboration.peerVideoSource() === 'screen' || session.screenSharing()) {
            <dx-assist-panel />
          }
          @if (session.fileTransfers.transfers().length) {
            <dx-file-transfer-list />
          }
        </aside>
      }
      <audio #remoteAudio autoplay></audio>
    </main>

    @if (isActive()) {
      <footer
        class="sticky bottom-0 border-t border-line bg-canvas/90 px-4 py-3 backdrop-blur sm:px-6"
      >
        <div
          role="group"
          aria-label="Call controls"
          class="flex flex-wrap justify-center gap-2 sm:gap-3"
        >
          <dx-control-button
            [label]="session.muted() ? 'Unmute' : 'Mute'"
            [pressed]="!session.muted()"
            (activated)="session.toggleMute()"
          />
          <dx-control-button
            [label]="session.cameraEnabled() ? 'Camera off' : 'Turn camera on'"
            [pressed]="session.cameraEnabled()"
            (activated)="session.toggleCamera()"
          />
          <dx-control-button
            [label]="session.screenSharing() ? 'Stop sharing' : 'Share screen'"
            [pressed]="session.screenSharing()"
            (activated)="session.toggleScreenSharing()"
          />
          @if (session.fileChannelOpen()) {
            <dx-control-button label="Send file" (activated)="openFilePicker()" />
            <input
              #filePicker
              class="hidden"
              type="file"
              multiple
              aria-label="Choose files to send"
              (change)="selectFiles($event)"
            />
          }
          <dx-control-button label="Leave" variant="danger" (activated)="leave()" />
        </div>
      </footer>
    }
  `,
})
export default class RoomPage implements OnDestroy {
  readonly roomId = input.required<string>();
  protected readonly session = inject(CallSessionService);
  protected readonly copied = signal(false);
  protected readonly overlay = signal({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    hostWidth: 0,
    hostHeight: 0,
  });
  protected readonly collaborationTools = [
    { id: 'off', label: 'Off', disabled: false },
    { id: 'pointer', label: 'Pointer', disabled: false },
    { id: 'laser', label: 'Laser', disabled: false },
    { id: 'draw', label: 'Draw', disabled: false },
  ] as const;
  protected readonly pipClasses =
    'absolute bottom-3 right-3 max-h-40 w-[min(28%,18rem)] rounded-2xl border border-line bg-surface-muted object-contain shadow-lg';
  protected readonly showConnectionPath = import.meta.env.DEV;
  protected readonly isValidRoom = computed(() => roomIdSchema.safeParse(this.roomId()).success);
  protected readonly isActive = computed(() =>
    ['waiting-for-peer', 'connecting', 'connected', 'reconnecting'].includes(this.session.state()),
  );
  protected readonly statusText = computed(() => {
    switch (this.session.state()) {
      case 'waiting-for-peer':
        return 'Waiting for someone to join…';
      case 'connecting':
        return 'Connecting…';
      case 'reconnecting':
        return 'Connection interrupted. Reconnecting…';
      default:
        return 'Connected';
    }
  });

  protected readonly statusTone = computed<StatusTone>(() => {
    switch (this.session.state()) {
      case 'connected':
        return 'ok';
      case 'reconnecting':
        return 'warn';
      default:
        return 'neutral';
    }
  });
  protected readonly showTools = computed(
    () =>
      this.session.screenSharing() ||
      this.session.collaboration.peerVideoSource() === 'screen' ||
      this.session.fileTransfers.transfers().length > 0,
  );

  private readonly remoteAudio = viewChild<ElementRef<HTMLAudioElement>>('remoteAudio');
  private readonly remoteVideo = viewChild<ElementRef<HTMLVideoElement>>('remoteVideo');
  private readonly localVideo = viewChild<ElementRef<HTMLVideoElement>>('localVideo');
  private readonly videoSurface = viewChild<ElementRef<HTMLElement>>('videoSurface');
  private readonly filePickerRef = viewChild<ElementRef<HTMLInputElement>>('filePicker');
  private resizeObserver: ResizeObserver | null = null;
  private observedSurface: HTMLElement | null = null;
  private observedVideos = new Set<HTMLVideoElement>();
  private pendingPointer: {
    readonly mode: 'pointer' | 'laser';
    readonly point: NormalizedPoint;
  } | null = null;
  private pointerFrame: number | null = null;
  private drawing = false;
  private controlButton: { pointerId: number; button: 'left' | 'right' } | null = null;

  constructor() {
    afterNextRender(preloadMovement);
    effect(() => {
      // Once input capture ends (revoke, expiry, surface change) forget any held-button bookkeeping.
      if (!this.session.remoteInput.capturing()) this.controlButton = null;
    });
    effect(() => {
      this.session.collaboration.surfaceRevision();
      this.cancelPendingPointer();
      const audio = this.remoteAudio()?.nativeElement;
      if (audio) {
        audio.srcObject = this.session.remoteAudioStream();
        if (audio.srcObject) void audio.play().catch(() => undefined);
      }
      const video = this.remoteVideo()?.nativeElement;
      if (video) {
        video.srcObject = this.session.remoteVideoStream();
        if (video.srcObject) void video.play().catch(() => undefined);
      }
      const local = this.localVideo()?.nativeElement;
      if (local) {
        local.srcObject = this.session.localVideoStream();
        if (local.srcObject) void local.play().catch(() => undefined);
      }
      const surface = this.videoSurface()?.nativeElement;
      if (surface !== this.observedSurface) {
        this.resizeObserver?.disconnect();
        this.observedSurface = surface ?? null;
        if (surface && typeof ResizeObserver !== 'undefined') {
          this.resizeObserver ??= new ResizeObserver(() => {
            this.measureOverlay();
          });
          this.resizeObserver.observe(surface);
        }
      }
      const videos = [this.remoteVideo()?.nativeElement, this.localVideo()?.nativeElement].filter(
        (video): video is HTMLVideoElement => video !== undefined,
      );
      for (const video of this.observedVideos) {
        if (!videos.includes(video)) {
          this.resizeObserver?.unobserve(video);
          video.removeEventListener('resize', this.measureOverlay);
          this.observedVideos.delete(video);
        }
      }
      for (const video of videos) {
        if (this.observedVideos.has(video)) continue;
        this.observedVideos.add(video);
        this.resizeObserver?.observe(video);
        video.addEventListener('resize', this.measureOverlay);
      }
      if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(this.measureOverlay);
    });
  }

  protected toolDisabled(id: string): boolean {
    const { collaboration, remoteInput } = this.session;
    return (
      remoteInput.capturing() ||
      ((id === 'pointer' || id === 'laser') && !collaboration.pointerChannelOpen()) ||
      (id === 'draw' && !collaboration.collaborationChannelOpen())
    );
  }

  protected overlayViewBox(): string {
    const { hostWidth, hostHeight } = this.overlay();
    return `0 0 ${String(Math.max(1, hostWidth))} ${String(Math.max(1, hostHeight))}`;
  }

  protected overlayTransform(): string {
    const { left, top, width, height } = this.overlay();
    return `translate(${String(left)} ${String(top)}) scale(${String(width)} ${String(height)})`;
  }

  protected strokePath(points: readonly NormalizedPoint[]): string {
    return points
      .map((point, index) => `${index ? 'L' : 'M'} ${String(point.x)} ${String(point.y)}`)
      .join(' ');
  }

  protected onSurfacePointerDown(event: PointerEvent): void {
    if (this.session.remoteInput.capturing()) {
      this.controlPointerDown(event);
      return;
    }
    if (this.session.collaboration.tool() !== 'draw') return;
    const point = this.normalizedPoint(event);
    if (!point) return;
    event.preventDefault();
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    this.drawing = true;
    this.session.collaboration.beginStroke(point);
  }

  protected onSurfacePointerMove(event: PointerEvent): void {
    if (this.session.remoteInput.capturing()) {
      // While a button is held the pointer is captured, so edge overshoot pins to the edge.
      const point = this.normalizedPoint(event, this.controlButton !== null);
      if (point) this.session.remoteInput.movePointer(point);
      return;
    }
    const point = this.normalizedPoint(event);
    if (!point) {
      if (!this.drawing) this.sendPointerHideSoon();
      return;
    }
    if (this.drawing) {
      this.session.collaboration.addStrokePoint(point);
      return;
    }
    const tool = this.session.collaboration.tool();
    if (tool === 'pointer' || tool === 'laser') {
      this.pendingPointer = { mode: tool, point };
      this.pointerFrame ??= requestAnimationFrame(() => {
        this.pointerFrame = null;
        const pending = this.pendingPointer;
        this.pendingPointer = null;
        if (pending) this.session.collaboration.sendPointer(pending.mode, pending.point);
      });
    }
  }

  protected onSurfacePointerUp(event: PointerEvent): void {
    const held = this.controlButton;
    if (held?.pointerId === event.pointerId) {
      this.controlButton = null;
      const target = event.currentTarget as SVGSVGElement;
      const point = this.normalizedPoint(event, true) ?? this.session.remoteInput.lastPointer();
      // Always release: a lost capture, cancel or revoke must never leave the remote button down.
      this.session.remoteInput.pointerButton(held.button, 'up', point);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      return;
    }
    if (!this.drawing) return;
    this.drawing = false;
    if ((event.currentTarget as SVGSVGElement).hasPointerCapture(event.pointerId))
      (event.currentTarget as SVGSVGElement).releasePointerCapture(event.pointerId);
    this.session.collaboration.finishStroke();
  }

  protected onSurfacePointerLeave(): void {
    if (this.session.remoteInput.capturing()) return;
    if (this.drawing) {
      this.drawing = false;
      this.session.collaboration.finishStroke();
    }
    this.sendPointerHideSoon();
  }

  protected onSurfaceContextMenu(event: Event): void {
    // Only swallow the browser menu while this surface is consuming right clicks as remote input.
    if (this.session.remoteInput.capturing()) event.preventDefault();
  }

  protected onSurfaceWheel(event: WheelEvent): void {
    if (!this.session.remoteInput.capturing() || !this.normalizedPoint(event)) return;
    event.preventDefault();
    const { deltaX, deltaY } = normalizeWheelDelta(event.deltaX, event.deltaY, event.deltaMode);
    this.session.remoteInput.scroll(deltaX, deltaY);
  }

  private controlPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'touch' || this.controlButton) return;
    const button = event.button === 0 ? 'left' : event.button === 2 ? 'right' : null;
    if (!button) return;
    const point = this.normalizedPoint(event);
    if (!point) return;
    event.preventDefault();
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    this.controlButton = { pointerId: event.pointerId, button };
    this.session.remoteInput.pointerButton(button, 'down', point);
  }

  private readonly measureOverlay = (): void => {
    const host = this.videoSurface()?.nativeElement;
    const video = this.activeVideoElement();
    if (!host || !video) {
      this.overlay.set({ left: 0, top: 0, width: 0, height: 0, hostWidth: 0, hostHeight: 0 });
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const videoRect = video.getBoundingClientRect();
    const content = containedVideoRect(
      videoRect.width,
      videoRect.height,
      video.videoWidth,
      video.videoHeight,
    );
    if (!content) return;
    this.overlay.set({
      left: videoRect.left - hostRect.left + content.left,
      top: videoRect.top - hostRect.top + content.top,
      width: content.width,
      height: content.height,
      hostWidth: hostRect.width,
      hostHeight: hostRect.height,
    });
  };

  private activeVideoElement(): HTMLVideoElement | null {
    if (this.session.collaboration.peerVideoSource() === 'screen')
      return this.remoteVideo()?.nativeElement ?? null;
    if (this.session.collaboration.localVideoSource() === 'screen')
      return this.localVideo()?.nativeElement ?? null;
    return null;
  }

  private normalizedPoint(event: MouseEvent, clamp = false): NormalizedPoint | null {
    const video = this.activeVideoElement();
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    return clientToNormalized(
      event.clientX,
      event.clientY,
      rect,
      video.videoWidth,
      video.videoHeight,
      clamp,
    );
  }

  private sendPointerHideSoon(): void {
    this.cancelPendingPointer();
    if (
      this.session.collaboration.tool() === 'pointer' ||
      this.session.collaboration.tool() === 'laser'
    )
      this.session.collaboration.sendPointerHide();
  }

  private cancelPendingPointer(): void {
    if (this.pointerFrame !== null && typeof cancelAnimationFrame !== 'undefined')
      cancelAnimationFrame(this.pointerFrame);
    this.pointerFrame = null;
    this.pendingPointer = null;
  }

  protected join(): void {
    void this.session.join(this.roomId());
  }
  protected leave(): void {
    this.session.leave();
  }

  protected selectFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) this.session.fileTransfers.sendFiles([...input.files]);
    input.value = '';
  }

  protected openFilePicker(): void {
    this.filePickerRef()?.nativeElement.click();
  }

  protected async copyLink(): Promise<void> {
    const text = this.session.copyLink();
    try {
      if (!window.isSecureContext) throw new Error('Clipboard requires a secure context.');
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => {
        this.copied.set(false);
      }, 2000);
    } catch {
      // The visible readonly URL remains selectable when clipboard access is unavailable.
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    for (const video of this.observedVideos)
      video.removeEventListener('resize', this.measureOverlay);
    if (this.pointerFrame !== null && typeof cancelAnimationFrame !== 'undefined')
      cancelAnimationFrame(this.pointerFrame);
    for (const ref of [this.remoteAudio(), this.remoteVideo(), this.localVideo()]) {
      if (ref) ref.nativeElement.srcObject = null;
    }
  }
}
