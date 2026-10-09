import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A labelled card for contextual tools (Assist, helper, file transfers). */
@Component({
  selector: 'dx-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section class="rounded-2xl border border-line bg-surface p-4" [attr.aria-label]="label()">
      @if (heading()) {
        <h2 class="mb-2 text-sm font-semibold tracking-tight">{{ heading() }}</h2>
      }
      <ng-content />
    </section>
  `,
})
export class Panel {
  /** Accessible name of the region. */
  readonly label = input.required<string>();
  /** Optional visible heading. */
  readonly heading = input('');
}
