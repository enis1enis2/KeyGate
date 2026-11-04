import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

function ModalHarness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  const close = () => {
    onClose();
    setOpen(false);
  };
  return (
    <>
      <button type="button">Outside</button>
      <Modal open={open} onClose={close} title="Rotate master key">
        <p>Body copy</p>
        <button type="button">First action</button>
        <button type="button">Second action</button>
      </Modal>
    </>
  );
}

describe('Modal', () => {
  it('renders an accessible modal dialog labelled by its title', () => {
    render(<ModalHarness />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Rotate master key');
    expect(screen.getByText('Body copy')).toBeInTheDocument();
  });

  it('does not render anything while closed', () => {
    render(
      <Modal open={false} onClose={() => {}} title="Hidden">
        <p>Never shown</p>
      </Modal>
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves initial focus into the dialog and restores it when closed', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
            Open dialog
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="Focus test">
            <button type="button">Inside</button>
          </Modal>
        </>
      );
    }

    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ModalHarness onClose={onClose} />);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab focus inside the dialog', async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);

    const closeButton = screen.getByRole('button', { name: 'Close dialog' });
    const second = screen.getByRole('button', { name: 'Second action' });

    expect(closeButton).toHaveFocus();

    await user.tab({ shift: true });
    expect(second).toHaveFocus();

    await user.tab();
    expect(closeButton).toHaveFocus();
  });

  it('closes when the backdrop is clicked but not when the panel is clicked', () => {
    const onClose = vi.fn();
    render(<ModalHarness onClose={onClose} />);

    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('makes the rest of the page inert and locks background scrolling', () => {
    const { container } = render(<ModalHarness />);

    expect(container).toHaveAttribute('aria-hidden', 'true');
    expect(container.inert).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
  });
});
