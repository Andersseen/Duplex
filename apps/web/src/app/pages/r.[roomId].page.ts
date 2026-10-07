import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { roomIdSchema } from '@duplex/protocol';

@Component({
  selector: 'dx-room-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-h-dvh flex-col px-6 py-8 sm:px-10' },
  template: `
    <header>
      <a
        routerLink="/"
        class="text-lg font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4"
        >Duplex</a
      >
    </header>

    <main class="flex flex-1 flex-col items-start justify-center gap-4 pb-16">
      @if (isValidRoom()) {
        <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">Joining Duplex room…</h1>
        <p class="max-w-prose text-lg text-zinc-600 dark:text-zinc-400">
          Calling is not built yet, so nobody is connected. This page only proves the link and
          routing work.
        </p>
      } @else {
        <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">Invalid room link</h1>
        <p class="max-w-prose text-lg text-zinc-600 dark:text-zinc-400">
          This link is not a Duplex room.
          <a routerLink="/" class="underline underline-offset-4">Start a new call</a>
        </p>
      }
    </main>
  `,
})
export default class RoomPage {
  /** Bound from the `:roomId` route parameter. */
  readonly roomId = input.required<string>();

  protected readonly isValidRoom = computed(() => roomIdSchema.safeParse(this.roomId()).success);
}
