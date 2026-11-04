import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Tailwind max-width class for the dialog panel. */
  widthClassName?: string;
}

// DECISION: Every dialog in the console is built on one component so accessibility is defined
// once: role=dialog + aria-modal, a labelled heading, initial focus, a Tab focus trap, Escape to
// close, focus restoration, and `inert` on the rest of the page. Rendering through a portal keeps
// the dialog outside the app container so the background can be inerted without inerting the dialog.
export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  children,
  widthClassName = 'max-w-lg',
}) => {
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const overlay = overlayRef.current;
    if (!overlay) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;

    // Inert + aria-hidden on every other top-level node so screen readers and Tab cannot reach
    // the console behind the dialog.
    const siblings = Array.from(document.body.children).filter(
      (el): el is HTMLElement => el !== overlay && el instanceof HTMLElement
    );
    const restorers = siblings.map((el) => {
      const hadInert = el.inert;
      const previousAriaHidden = el.getAttribute('aria-hidden');
      el.inert = true;
      el.setAttribute('aria-hidden', 'true');
      return () => {
        el.inert = hadInert;
        if (previousAriaHidden === null) el.removeAttribute('aria-hidden');
        else el.setAttribute('aria-hidden', previousAriaHidden);
      };
    });

    document.body.style.overflow = 'hidden';

    const dialog = overlay.querySelector<HTMLElement>('[role="dialog"]');
    const focusablesIn = (): HTMLElement[] =>
      dialog
        ? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
            (el) => el.offsetParent !== null || el === document.activeElement
          )
        : [];

    const first = focusablesIn()[0];
    (first ?? dialog)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;

      const focusables = focusablesIn();
      if (focusables.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const firstEl = focusables[0]!;
      const lastEl = focusables[focusables.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey && (active === firstEl || active === dialog)) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && active === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      restorers.forEach((restore) => restore());
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`bg-slate-900 border border-slate-800 rounded-xl w-full ${widthClassName} p-6 shadow-2xl space-y-4 outline-none`}
      >
        <div className="flex items-center justify-between gap-4 pb-2 border-b border-slate-800">
          <h2 id={titleId} className="text-base font-bold text-white">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="min-h-6 min-w-6 inline-flex items-center justify-center rounded text-slate-400 hover:text-white text-lg font-bold leading-none"
          >
            &times;
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
};
