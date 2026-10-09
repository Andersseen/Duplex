import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

export type ControlButtonVariant = 'secondary' | 'primary' | 'danger';

const BASE =
  'inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:text-base';

const VARIANTS: Record<ControlButtonVariant, string> = {
  secondary: 'border border-line bg-surface text-ink hover:bg-surface-muted',
  primary: 'bg-ink text-ink-inverse hover:opacity-90',
  danger: 'bg-danger text-ink-inverse hover:opacity-90',
};

/** One button style for every call and panel action; the label is the accessible name. */
@Component({
  selector: 'dx-control-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex' },
  template: `
    <button
      type="button"
      [class]="classes()"
      [attr.aria-pressed]="pressed()"
      [disabled]="disabled()"
      (click)="activated.emit()"
    >
      {{ label() }}
    </button>
  `,
})
export class ControlButton {
  readonly label = input.required<string>();
  readonly variant = input<ControlButtonVariant>('secondary');
  /** Omit for plain actions; set for toggles so assistive tech announces the state. */
  readonly pressed = input<boolean | undefined>(undefined);
  readonly disabled = input(false);
  readonly activated = output();

  protected readonly classes = computed(() => `${BASE} ${VARIANTS[this.variant()]}`);
}
