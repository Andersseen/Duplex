import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type StatusTone = 'neutral' | 'ok' | 'warn' | 'danger';

const TONES: Record<StatusTone, string> = {
  neutral: 'text-ink-muted',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
};

/** Short status text with a colour dot; the text always carries the meaning. */
@Component({
  selector: 'dx-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span [class]="classes()">
      <span aria-hidden="true" class="size-2 rounded-full bg-current"></span>
      <ng-content />
    </span>
  `,
})
export class StatusBadge {
  readonly tone = input<StatusTone>('neutral');

  protected readonly classes = computed(
    () =>
      `inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-sm ${TONES[this.tone()]}`,
  );
}
