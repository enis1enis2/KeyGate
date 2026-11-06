import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from './components/Navbar';
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
import { isDemoMode } from './demo/mode';
import type { 
  DashboardStats, 
  Provider, 
  ApiKeyItem, 
  ModelAlias, 
  GatewayKey 
} from './types';

const POLL_INTERVAL_MS = 15_000;
const demoMode = isDemoMode();

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

  if (needsAuth) {
    return <AdminLogin error={authError} onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:rounded-lg focus:bg-indigo-600 focus:text-white focus:text-sm"
      >
        Skip to content
      </a>

      <Navbar 
        activeTab={activeTab} 
        setActiveTab={setActiveTab} 
        stats={stats} 
      />

      <main id="main-content" tabIndex={-1} className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 outline-none">
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
              <ProvidersTab 
                providers={providers} 
                onRefresh={loadData} 
              />
            )}

            {activeTab === 'keys' && (
              <KeysTab 
                keys={keys} 
                providers={providers} 
                onRefresh={loadData} 
              />
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
              <PricingTab 
                providers={providers} 
                onRefresh={loadData} 
              />
            )}

            {activeTab === 'gateway' && (
              <GatewayKeysTab 
                gatewayKeys={gatewayKeys} 
                aliases={aliases}
                onRefresh={loadData} 
              />
            )}

            {activeTab === 'playground' && (
              <PlaygroundTab 
                aliases={aliases} 
              />
            )}

            {activeTab === 'history' && (
              <HistoryTab 
                poolNames={aliases.map((a) => a.alias_name)} 
              />
            )}

            {activeTab === 'logs' && (
              <LogsTab 
                providers={providers} 
              />
            )}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-6 text-center text-xs text-slate-400">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-300">KeyGate Gateway</span>
            <span>•</span>
            <span>{demoMode ? 'Interactive demo · mock data' : 'Self-Hosted AI API Pool'}</span>
          </div>

          <div className="flex items-center gap-4 font-mono">
            <span aria-live="polite" className="text-slate-400">
              {isStale ? (
                <span className="text-amber-400">Reconnecting…</span>
              ) : lastUpdated ? (
                `Updated ${lastUpdated.toLocaleTimeString()}`
              ) : null}
            </span>
            {demoMode ? (
              <a
                href="https://github.com/enis1enis2/KeyGate"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-indigo-400 transition-colors"
              >
                source
              </a>
            ) : (
              <>
                <a href="/healthz" target="_blank" rel="noopener noreferrer" className="hover:text-indigo-400 transition-colors">/healthz</a>
                <a href="/metrics" target="_blank" rel="noopener noreferrer" className="hover:text-indigo-400 transition-colors">/metrics</a>
                <a href="/v1/models" target="_blank" rel="noopener noreferrer" className="hover:text-indigo-400 transition-colors">/v1/models</a>
              </>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
