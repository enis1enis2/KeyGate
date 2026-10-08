import React, { useState, useEffect } from 'react';
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
import type { 
  DashboardStats, 
  Provider, 
  ApiKeyItem, 
  ModelAlias, 
  GatewayKey 
} from './types';

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

  const loadData = () => {
    if (!getAdminToken()) return Promise.resolve();

    return Promise.all([
      fetchStats().catch(() => null),
      fetchProviders().catch(() => []),
      fetchKeys().catch(() => []),
      fetchAliases().catch(() => []),
      fetchGatewayKeys().catch(() => []),
    ])
      .then(([s, p, k, a, g]) => {
        if (s) setStats(s);
        setProviders(p);
        setKeys(k);
        setAliases(a);
        setGatewayKeys(g);
        setNeedsAuth(false);
        setAuthError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof UnauthorizedError) {
          setAuthError(err.message);
          setNeedsAuth(true);
          return;
        }
        console.error('Failed to load gateway data:', err);
      })
      .finally(() => {
        setIsLoading(false);
      });
  };

  const handleAuthenticated = () => {
    setIsLoading(true);
    loadData();
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    const unsubscribe = subscribeToUnauthorized((message) => {
      setAuthError(message);
      setNeedsAuth(true);
      setIsLoading(false);
    });
    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, []);

  if (needsAuth) {
    return <AdminLogin error={authError} onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      <Navbar 
        activeTab={activeTab} 
        setActiveTab={setActiveTab} 
        stats={stats} 
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
            <span>Self-Hosted AI API Pool</span>
          </div>

          <div className="flex items-center gap-4 font-mono">
            <a href="/healthz" target="_blank" className="hover:text-indigo-400 transition-colors">/healthz</a>
            <a href="/metrics" target="_blank" className="hover:text-indigo-400 transition-colors">/metrics</a>
            <a href="/v1/models" target="_blank" className="hover:text-indigo-400 transition-colors">/v1/models</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
