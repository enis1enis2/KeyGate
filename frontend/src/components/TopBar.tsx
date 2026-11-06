import React from 'react';
import { ChevronRight, Menu, RefreshCw } from 'lucide-react';
import type { DashboardStats } from '../types';
import { isDemoMode } from '../demo/mode';
import { findNavItem, findNavSection } from './navigation';

const demoMode = isDemoMode();

interface TopBarProps {
  activeTab: string;
  navOpen: boolean;
  menuButtonRef: React.RefObject<HTMLButtonElement | null>;
  onOpenNav: () => void;
  onRefresh: () => void;
  stats: DashboardStats | null;
  lastUpdated: Date | null;
  isStale: boolean;
}

// DECISION: The top bar is deliberately thin. It answers three questions in one line —
// where am I, is the data live, and how do I refresh — instead of repeating the nine
// destinations that are already visible in the rail.
export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  navOpen,
  menuButtonRef,
  onOpenNav,
  onRefresh,
  stats,
  lastUpdated,
  isStale,
}) => {
  const section = findNavSection(activeTab);
  const item = findNavItem(activeTab);
  const successRate = stats?.successRate ?? 100;
  const isHealthy = successRate >= 95;

  return (
    <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-slate-950/85 backdrop-blur supports-[backdrop-filter]:bg-slate-950/70">
      <div className="mx-auto flex h-16 w-full max-w-[90rem] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={onOpenNav}
          aria-label="Open navigation"
          aria-controls="app-sidebar"
          aria-expanded={navOpen}
          className="-ml-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-800 text-slate-300 transition-colors hover:bg-slate-800/60 hover:text-white lg:hidden"
        >
          <Menu className="h-4 w-4" aria-hidden="true" />
        </button>

        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em]"
        >
          <span className="hidden truncate text-slate-500 sm:inline">{section?.label ?? 'Console'}</span>
          <ChevronRight className="hidden h-3 w-3 shrink-0 text-slate-600 sm:block" aria-hidden="true" />
          <span className="truncate text-slate-200" aria-current="page">
            {item?.label ?? 'Dashboard'}
          </span>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {demoMode && (
            <span className="inline-flex items-center rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-amber-300 lg:hidden">
              Demo
            </span>
          )}
          <span aria-live="polite" className="font-mono text-[10px] text-slate-500 sm:text-[11px]">
            {isStale ? (
              <span className="text-amber-400">Reconnecting…</span>
            ) : lastUpdated ? (
              `Updated ${lastUpdated.toLocaleTimeString()}`
            ) : (
              'Connecting…'
            )}
          </span>

          <span className="hidden items-center gap-1.5 rounded-full border border-slate-800 bg-slate-900/60 px-2.5 py-1 font-mono text-[11px] text-slate-400 sm:inline-flex">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${isHealthy ? 'bg-emerald-400' : 'bg-amber-400'}`}
            />
            {successRate}% 24h
          </span>

          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh data"
            title="Refresh data"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-800 text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-white"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
};
