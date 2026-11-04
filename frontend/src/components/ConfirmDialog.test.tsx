import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('renders the message with default actions', () => {
    render(
      <ConfirmDialog
        open
        title="Delete provider"
        message="This cannot be undone."
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Delete provider');
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('calls onConfirm and onCancel from the matching buttons', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        open
        title="Revoke key"
        message="Revoke it?"
        confirmLabel="Revoke"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables the confirm action and shows progress while busy', () => {
    render(
      <ConfirmDialog
        open
        title="Working"
        message="Please wait"
        busy
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    const confirm = screen.getByRole('button', { name: 'Working…' });
    expect(confirm).toBeDisabled();
  });

  it('applies destructive styling only when asked', () => {
    const { rerender } = render(
      <ConfirmDialog open title="Delete" message="Sure?" onConfirm={() => {}} onCancel={() => {}} />
    );

    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm.className).toContain('bg-indigo-600');

    rerender(
      <ConfirmDialog open title="Delete" message="Sure?" destructive onConfirm={() => {}} onCancel={() => {}} />
    );
    expect(screen.getByRole('button', { name: 'Confirm' }).className).toContain('bg-rose-600');
  });
});
