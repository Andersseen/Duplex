import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { createRoomId } from '@duplex/protocol';

@Component({
  selector: 'dx-landing-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-dvh flex-col px-6 py-8 sm:px-10' },
  template: `
    <header>
      <span class="text-lg font-semibold tracking-tight">Duplex</span>
    </header>

    <main class="flex flex-1 flex-col items-start justify-center gap-8 pb-16">
      <div class="flex flex-col gap-3">
        <h1 class="text-5xl font-semibold tracking-tight sm:text-7xl">Start a call</h1>
        <p class="text-xl text-zinc-600 sm:text-2xl dark:text-zinc-400">
          Share a link.<br />That's it.
        </p>
      </div>

      <button
        type="button"
        class="rounded-full bg-zinc-900 px-7 py-3.5 text-base font-medium text-zinc-50 transition-transform duration-150 hover:scale-[1.02] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zinc-900 active:scale-100 dark:bg-zinc-50 dark:text-zinc-900 dark:focus-visible:outline-zinc-50"
        (click)="startCall()"
      >
        Start a call
      </button>
    </main>
  `,
})
export default class LandingPage {
  private readonly router = inject(Router);

  protected startCall(): void {
    // Room IDs are opaque 128-bit random tokens. A room only comes to exist when
    // its Durable Object is first addressed, so there is nothing to create yet.
    void this.router.navigate(['/r', createRoomId()]);
  }
}
