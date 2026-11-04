import React from 'react';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Use the danger styling for destructive actions (delete/revoke). */
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// DECISION: window.confirm() blocks the event loop, cannot be styled, is suppressed by some
// browsers, and is announced inconsistently by screen readers. A real dialog keeps the same
// two-step safety while remaining keyboard- and AT-accessible.
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}) => (
  <Modal open={open} onClose={onCancel} title={title} widthClassName="max-w-md">
    <div className="text-sm text-slate-300">{message}</div>
    <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
      <button
        type="button"
        onClick={onCancel}
        className="min-h-8 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-lg transition-colors"
      >
        {cancelLabel}
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className={`min-h-8 px-4 py-2 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-md transition-colors ${
          destructive
            ? 'bg-rose-600 hover:bg-rose-500 shadow-rose-500/20'
            : 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-500/20'
        }`}
      >
        {busy ? 'Working…' : confirmLabel}
      </button>
    </div>
  </Modal>
);
