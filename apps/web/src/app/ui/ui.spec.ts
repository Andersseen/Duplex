import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/angular';
import { userEvent } from '@testing-library/user-event';
import { ControlButton } from './control-button';
import { Panel } from './panel';
import { StatusBadge } from './status-badge';

describe('ControlButton', () => {
  it('uses its label as the accessible name and emits on activation', async () => {
    const user = userEvent.setup();
    const activated = vi.fn();
    await render(ControlButton, { inputs: { label: 'Mute' }, on: { activated } });

    await user.click(screen.getByRole('button', { name: 'Mute' }));

    expect(activated).toHaveBeenCalledOnce();
  });

  it('exposes toggle state only when a pressed value is provided', async () => {
    const { rerender } = await render(ControlButton, { inputs: { label: 'Camera' } });
    expect(screen.getByRole('button', { name: 'Camera' })).not.toHaveAttribute('aria-pressed');

    await rerender({ inputs: { label: 'Camera', pressed: false } });
    expect(screen.getByRole('button', { name: 'Camera' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not emit while disabled', async () => {
    const user = userEvent.setup();
    const activated = vi.fn();
    await render(ControlButton, {
      inputs: { label: 'Allow', disabled: true },
      on: { activated },
    });

    await user.click(screen.getByRole('button', { name: 'Allow' }));

    expect(activated).not.toHaveBeenCalled();
  });

  it.each(['secondary', 'primary', 'danger'] as const)(
    'renders the %s variant',
    async (variant) => {
      await render(ControlButton, { inputs: { label: 'Go', variant } });
      expect(screen.getByRole('button', { name: 'Go' })).toBeVisible();
    },
  );
});

describe('StatusBadge', () => {
  it.each(['neutral', 'ok', 'warn', 'danger'] as const)(
    'carries the status in text for the %s tone',
    async (tone) => {
      await render(`<dx-status-badge [tone]="tone">Connected</dx-status-badge>`, {
        imports: [StatusBadge],
        componentProperties: { tone },
      });
      expect(screen.getByText('Connected')).toBeVisible();
    },
  );
});

describe('Panel', () => {
  it('exposes a named region with an optional visible heading', async () => {
    await render(`<dx-panel label="Assist control" heading="Assist">Body</dx-panel>`, {
      imports: [Panel],
    });

    expect(screen.getByRole('region', { name: 'Assist control' })).toHaveTextContent('Body');
    expect(screen.getByRole('heading', { level: 2, name: 'Assist' })).toBeVisible();
  });

  it('omits the heading when none is given', async () => {
    await render(`<dx-panel label="Quiet">Body</dx-panel>`, { imports: [Panel] });

    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});
