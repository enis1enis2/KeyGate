import React, { useEffect, useRef } from 'react';
import { ShieldCheck, Radio, X } from 'lucide-react';
import type { DashboardStats } from '../types';
import { isDemoMode } from '../demo/mode';
import { NAV_SECTIONS } from './navigation';

const demoMode = isDemoMode();

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface SidebarProps {
  activeTab: string;
  onNavigate: (tab: string) => void;
  onClose: () => void;
  /** True while the mobile drawer is open. On desktop the rail is always visible. */
  open: boolean;
  /** Removes the off-canvas rail from the tab order and the accessibility tree. */
  inert?: boolean;
  stats: DashboardStats | null;
}

// DECISION: The rail is a fixed 256 px column on desktop and an off-canvas drawer below
// `lg`. The drawer implementation mirrors Modal.tsx: Escape closes, Tab is trapped, body
// scroll locks, and focus moves to the current page then returns to the menu button. The
// rail doubles as the status panel so the content column stays free of chrome.
export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onNavigate,
  onClose,
  open,
  inert = false,
  stats,
}) => {
  const asideRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const aside = asideRef.current;
    if (!aside) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusablesIn = (): HTMLElement[] =>
      Array.from(aside.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );

    const activeItem = aside.querySelector<HTMLElement>('[aria-current="page"]');
    (activeItem ?? focusablesIn()[0] ?? aside).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusables = focusablesIn();
      if (focusables.length === 0) {
        event.preventDefault();
        aside.focus();
        return;
      }

      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === aside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open]);

  const successRate = stats?.successRate ?? 100;
  const isHealthy = successRate >= 95;

  return (
    <>
      {/* Mobile scrim. It stays mounted so opening and closing both animate. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-slate-950/70 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none lg:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      <aside
        id="app-sidebar"
        ref={asideRef}
        tabIndex={-1}
        aria-label="Console navigation"
        aria-hidden={inert || undefined}
        inert={inert || undefined}
        className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-slate-800/80 bg-slate-950/95 shadow-2xl shadow-black/40 backdrop-blur transition-transform duration-200 ease-out motion-reduce:transition-none lg:w-64 lg:translate-x-0 lg:shadow-none ${
          open ? 'translate-x-0' : '-translate-x-full'
        } outline-none`}
      >
        {/* Brand */}
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-800/80 px-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 shadow-lg shadow-indigo-500/20">
            <ShieldCheck className="h-5 w-5 text-white" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-bold tracking-tight text-white">KeyGate</span>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
                  demoMode
                    ? 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                    : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400'
                }`}
              >
                <Radio
                  className={`h-2.5 w-2.5 ${demoMode ? '' : 'animate-pulse motion-reduce:animate-none'}`}
                  aria-hidden="true"
                />
                {demoMode ? 'Demo' : 'Live'}
              </span>
            </div>
            <p className="truncate font-mono text-[9px] uppercase tracking-[0.18em] text-slate-500">
              AI gateway console
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="ml-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800/70 hover:text-white lg:hidden"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Destinations */}
        <nav aria-label="Console sections" className="console-scroll flex-1 overflow-y-auto px-3 py-4">
          {NAV_SECTIONS.map((section) => (
            <div key={section.id} className="mb-5 last:mb-0">
              <p className="px-3 pb-2 font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">
                {section.label}
              </p>
              <ul className="space-y-0.5">
                {section.items.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  return (
                    <li key={tab.id}>
                      <button
                        type="button"
                        onClick={() => onNavigate(tab.id)}
                        aria-current={isActive ? 'page' : undefined}
                        className={`group relative flex w-full items-center gap-3 rounded-lg py-2 pl-3.5 pr-2 text-sm transition-colors ${
                          isActive
                            ? 'bg-indigo-500/10 font-medium text-white'
                            : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-100'
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`absolute inset-y-1.5 left-0 w-0.5 rounded-full transition-colors ${
                            isActive ? 'bg-indigo-400' : 'bg-transparent'
                          }`}
                        />
                        <Icon
                          className={`h-4 w-4 shrink-0 ${
                            isActive ? 'text-indigo-300' : 'text-slate-500 group-hover:text-slate-300'
                          }`}
                          aria-hidden="true"
                        />
                        <span className="truncate">{tab.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Live status + endpoint links */}
        <div className="shrink-0 space-y-3 border-t border-slate-800/80 px-4 py-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-slate-800/80 bg-slate-900/50 px-2.5 py-2">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-slate-500">Active keys</p>
              <p className="mt-0.5 font-mono text-sm text-slate-200">
                <span className="text-emerald-400">{stats?.activeKeys ?? 0}</span>
                <span className="text-slate-600"> / {stats?.totalKeys ?? 0}</span>
              </p>
            </div>
            <div className="rounded-lg border border-slate-800/80 bg-slate-900/50 px-2.5 py-2">
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-slate-500">24h success</p>
              <p className="mt-0.5 font-mono text-sm text-slate-200">
                <span className={isHealthy ? 'text-emerald-400' : 'text-amber-400'}>{successRate}%</span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-slate-500">
            {demoMode ? (
              <a
                href="https://github.com/enis1enis2/KeyGate"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-indigo-300"
              >
                source
              </a>
            ) : (
              <>
                <a href="/healthz" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-indigo-300">
                  /healthz
                </a>
                <a href="/metrics" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-indigo-300">
                  /metrics
                </a>
                <a href="/v1/models" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-indigo-300">
                  /v1/models
                </a>
              </>
            )}
          </div>

          <p className="text-[10px] leading-relaxed text-slate-600">
            {demoMode
              ? 'Interactive demo · mock data resets on reload.'
              : 'Self-hosted · data stays on your network.'}
          </p>
        </div>
      </aside>
    </>
  );
};
