import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { AdminLogin } from './components/AdminLogin';
import { DashboardTab } from './components/DashboardTab';
import { ProvidersTab } from './components/ProvidersTab';
import { KeysTab } from './components/KeysTab';
import { RoutingTab } from './components/RoutingTab';
import { PricingTab } from './components/PricingTab';
import { GatewayKeysTab } from './components/GatewayKeysTab';
import { PlaygroundTab } from './components/PlaygroundTab';
import { HistoryTab } from './components/HistoryTab';
import { LogsTab } from './components/LogsTab';

import { 
  fetchStats, 
  fetchProviders, 
  fetchKeys, 
  fetchAliases, 
  fetchGatewayKeys,
  getAdminToken,
  subscribeToUnauthorized,
  UnauthorizedError 
} from './api';
import type { 
  DashboardStats, 
  Provider, 
  ApiKeyItem, 
  ModelAlias, 
  GatewayKey 
} from './types';

const POLL_INTERVAL_MS = 15_000;
const DESKTOP_QUERY = '(min-width: 1024px)';

// DECISION: A backgrounded console tab used to poll five endpoints every 5 seconds forever.
// The refresh loop now runs only while the tab is visible, at a calmer cadence, aborts the
// previous cycle instead of stacking requests, and surfaces staleness so the operator can tell
// live data from a frozen screen.
function orFallback<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return promise.catch((err: unknown) => {
    if (err instanceof UnauthorizedError) throw err;
    return fallback;
  });
}

export function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [aliases, setAliases] = useState<ModelAlias[]>([]);
  const [gatewayKeys, setGatewayKeys] = useState<GatewayKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [needsAuth, setNeedsAuth] = useState(() => !getAdminToken());
  const [authError, setAuthError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isStale, setIsStale] = useState(false);

  // The sidebar is fixed on desktop and an off-canvas drawer below `lg`. Tracking the
  // breakpoint lets the shell inert the content only while the drawer is actually modal.
  const [navOpen, setNavOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(DESKTOP_QUERY).matches
  );
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const wasNavOpen = useRef(false);

  const closeNav = useCallback(() => setNavOpen(false), []);
  const handleNavigate = useCallback((tab: string) => {
    setActiveTab(tab);
    setNavOpen(false);
  }, []);

  const runLoad = useCallback(async (signal?: AbortSignal) => {
    if (!getAdminToken()) return;

    try {
      const [s, p, k, a, g] = await Promise.all([
        orFallback(fetchStats({ signal }), null),
        orFallback(fetchProviders({ signal }), []),
        orFallback(fetchKeys({ signal }), []),
        orFallback(fetchAliases({ signal }), []),
        orFallback(fetchGatewayKeys({ signal }), []),
      ]);
      if (signal?.aborted) return;
      if (s) setStats(s);
      setProviders(p);
      setKeys(k);
      setAliases(a);
      setGatewayKeys(g);
      setNeedsAuth(false);
      setAuthError(null);
      setIsStale(false);
      setLastUpdated(new Date());
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof UnauthorizedError) {
        setAuthError(err.message);
        setNeedsAuth(true);
        return;
      }
      console.error('Failed to load gateway data:', err);
      setIsStale(true);
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, []);

  const loadData = useCallback(() => {
    void runLoad();
  }, [runLoad]);

  const handleAuthenticated = () => {
    setIsLoading(true);
    loadData();
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const schedule = () => {
      if (cancelled) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { void tick(); }, POLL_INTERVAL_MS);
    };

    const tick = async () => {
      timer = null;
      if (cancelled) return;
      // A hidden tab has nobody watching it; refresh immediately when it becomes visible again.
      if (document.visibilityState !== 'visible') return;

      controller?.abort();
      controller = new AbortController();
      await runLoad(controller.signal);
      if (!cancelled) schedule();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        void tick();
      } else if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const onOnline = () => {
      if (!cancelled) void tick();
    };

    void tick();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', onOnline);

    const unsubscribe = subscribeToUnauthorized((message) => {
      setAuthError(message);
      setNeedsAuth(true);
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', onOnline);
      unsubscribe();
    };
  }, [runLoad]);

  // Resizing to desktop retires the drawer (and its focus trap) instead of leaving an
  // invisible modal state behind.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => {
      setIsDesktop(query.matches);
      if (query.matches) setNavOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Closing the drawer hands focus back to the menu button that opened it. The first
  // render must not steal focus from the page.
  useEffect(() => {
    if (wasNavOpen.current && !navOpen) menuButtonRef.current?.focus();
    wasNavOpen.current = navOpen;
  }, [navOpen]);

  if (needsAuth) {
    return <AdminLogin error={authError} onAuthenticated={handleAuthenticated} />;
  }

  const drawerOpen = navOpen && !isDesktop;
  const railHidden = !isDesktop && !navOpen;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      <Sidebar
        activeTab={activeTab}
        onNavigate={handleNavigate}
        onClose={closeNav}
        open={navOpen}
        inert={railHidden}
        stats={stats}
      />

      <div className="flex min-h-screen flex-col lg:pl-64" inert={drawerOpen || undefined}>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:px-3 focus:py-2 focus:rounded-lg focus:bg-indigo-600 focus:text-white focus:text-sm"
        >
          Skip to content
        </a>

        <TopBar
          activeTab={activeTab}
          navOpen={navOpen}
          menuButtonRef={menuButtonRef}
          onOpenNav={() => setNavOpen(true)}
          onRefresh={loadData}
          stats={stats}
          lastUpdated={lastUpdated}
          isStale={isStale}
        />

        <main id="main-content" tabIndex={-1} className="w-full flex-1 scroll-mt-16 outline-none">
          <div className="mx-auto w-full max-w-[90rem] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            {isLoading && !stats ? (
              <div className="flex items-center justify-center py-20 text-slate-400 font-mono text-sm">
                <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mr-3"></div>
                Connecting to KeyGate backend...
              </div>
            ) : (
              <>
                {activeTab === 'dashboard' && (
                  <DashboardTab
                    stats={stats}
                    keys={keys}
                    aliases={aliases}
                    onRefresh={loadData}
                  />
                )}

                {activeTab === 'providers' && (
                  <ProvidersTab providers={providers} onRefresh={loadData} />
                )}

                {activeTab === 'keys' && (
                  <KeysTab keys={keys} providers={providers} onRefresh={loadData} />
                )}

                {activeTab === 'routing' && (
                  <RoutingTab
                    aliases={aliases}
                    providers={providers}
                    stats={stats}
                    onRefresh={loadData}
                  />
                )}

                {activeTab === 'pricing' && (
                  <PricingTab providers={providers} onRefresh={loadData} />
                )}

                {activeTab === 'gateway' && (
                  <GatewayKeysTab
                    gatewayKeys={gatewayKeys}
                    aliases={aliases}
                    onRefresh={loadData}
                  />
                )}

                {activeTab === 'playground' && <PlaygroundTab aliases={aliases} />}

                {activeTab === 'history' && (
                  <HistoryTab poolNames={aliases.map((a) => a.alias_name)} />
                )}

                {activeTab === 'logs' && <LogsTab providers={providers} />}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
