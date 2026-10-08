import React from 'react';
import { 
  Activity, 
  CheckCircle2, 
  Clock, 
  RefreshCw, 
  Zap, 
  ShieldAlert,
  RotateCcw,
  Power,
  Wallet,
  DollarSign
} from 'lucide-react';
import type { DashboardStats, ApiKeyItem, ModelAlias } from '../types';
import { updateKey } from '../api';

interface DashboardTabProps {
  stats: DashboardStats | null;
  keys: ApiKeyItem[];
  aliases: ModelAlias[];
  onRefresh: () => void;
}

export const DashboardTab: React.FC<DashboardTabProps> = ({ stats, keys, aliases, onRefresh }) => {
  const [resettingId, setResettingId] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleResetCircuit = async (keyId: string) => {
    setResettingId(keyId);
    try {
      await updateKey(keyId, { reset_circuit: true });
      onRefresh();
    } finally {
      setResettingId(null);
    }
  };

  const handleToggleKey = async (key: ApiKeyItem) => {
    await updateKey(key.id, { is_active: !key.is_active });
    onRefresh();
  };

  const formatCooldown = (cooldownUntil: number) => {
    if (!cooldownUntil || cooldownUntil <= now) return null;
    const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
    if (remainingSec > 3600) {
      return `${Math.round(remainingSec / 3600)}h remaining`;
    }
    if (remainingSec > 60) {
      return `${Math.round(remainingSec / 60)}m remaining`;
    }
    return `${remainingSec}s remaining`;
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Quick Refresh */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-2 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">System Health & Live Metrics</h1>
          <p className="text-sm text-slate-400">Real-time status of upstream API key pools and circuit breakers</p>
        </div>
        <button
          onClick={onRefresh}
          className="flex items-center gap-2 px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700/80 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh Stats
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">

        <div className="bg-slate-900/60 p-5 rounded-xl border border-slate-800/80">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">24h Requests</span>
            <Activity className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold text-white font-mono">{stats?.totalRequests ?? 0}</span>
            <span className="text-xs text-slate-400 font-mono">calls</span>
          </div>
          <div className="mt-2 flex items-center gap-3 text-xs text-slate-400 font-mono">
            <span className="text-emerald-400">{stats?.successRequests ?? 0} ok</span>
            <span>•</span>
            <span className="text-rose-400">{stats?.errorRequests ?? 0} err</span>
          </div>
        </div>

        {/* Success Rate */}
        <div className="bg-slate-900/60 p-5 rounded-xl border border-slate-800/80">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Success Rate</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className={`text-3xl font-bold font-mono ${
              (stats?.successRate ?? 100) >= 95 ? 'text-emerald-400' : 'text-amber-400'
            }`}>
              {stats?.successRate ?? 100}%
            </span>
          </div>
          <div className="mt-2 text-xs text-slate-400">
            Rolling last 24h gateway reliability
          </div>
        </div>

        {/* Latency Percentiles */}
        <div className="bg-slate-900/60 p-5 rounded-xl border border-slate-800/80">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Latency Percentiles</span>
            <Clock className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="mt-3 flex items-baseline gap-4 font-mono">
            <div>
              <span className="text-xs text-slate-400 block">p50</span>
              <span className="text-2xl font-bold text-white">{stats?.p50LatencyMs ?? 0}ms</span>
            </div>
            <div className="border-l border-slate-800 pl-4">
              <span className="text-xs text-slate-400 block">p95</span>
              <span className="text-2xl font-bold text-white">{stats?.p95LatencyMs ?? 0}ms</span>
            </div>
          </div>
          <div className="mt-2 text-xs text-slate-400 font-mono">
            avg {stats?.avgLatencyMs ?? 0}ms
          </div>
        </div>

        {/* Circuit Breakers State */}
        <div className="bg-slate-900/60 p-5 rounded-xl border border-slate-800/80">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Circuit Breakers</span>
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div className="mt-3 flex items-center gap-3 font-mono">
            <div className="flex items-center gap-1.5 bg-emerald-500/10 text-emerald-400 px-2.5 py-1 rounded border border-emerald-500/20 text-xs font-semibold">
              <span>{stats?.circuits.closed ?? 0}</span> Closed
            </div>
            <div className="flex items-center gap-1.5 bg-rose-500/10 text-rose-400 px-2.5 py-1 rounded border border-rose-500/20 text-xs font-semibold">
              <span>{stats?.circuits.open ?? 0}</span> Open
            </div>
            <div className="flex items-center gap-1.5 bg-amber-500/10 text-amber-400 px-2.5 py-1 rounded border border-amber-500/20 text-xs font-semibold">
              <span>{stats?.circuits.halfOpen ?? 0}</span> Probe
            </div>
          </div>
          <div className="mt-2 text-xs text-slate-400 font-mono">
            Auto-recovering via exponential backoff
          </div>
        </div>

        {/* Spend Today */}
        <div className="bg-slate-900/60 p-5 rounded-xl border border-slate-800/80">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Spend (Today UTC)</span>
            <DollarSign className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-3xl font-bold text-white font-mono">
              ${(stats?.spendToday ?? 0).toFixed(4)}
            </span>
            <span className="text-xs text-slate-400 font-mono">USD</span>
          </div>
          <div className="mt-2 text-xs text-slate-400 font-mono">
            Metered from model_pricing · resets at UTC midnight
          </div>
        </div>
      </div>

      {/* Pool & Budget Usage */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-slate-900/60 rounded-xl border border-slate-800/80 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-800 flex items-center gap-2">
            <Wallet className="w-4 h-4 text-indigo-400" />
            <h2 className="text-base font-semibold text-white">AI Pool Usage Today</h2>
          </div>
          {(stats?.poolUsageToday ?? []).length === 0 ? (
            <div className="p-6 text-center text-slate-400 text-sm">
              No pool traffic yet today.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs font-mono">
                <thead>
                  <tr className="bg-slate-950/60 text-slate-400 border-b border-slate-800 uppercase tracking-wider text-[11px]">
                    <th className="py-3 px-4">Pool</th>
                    <th className="py-3 px-4 text-right">Requests</th>
                    <th className="py-3 px-4 text-right">Tokens</th>
                    <th className="py-3 px-4 text-right">Spend / Cap</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {(stats?.poolUsageToday ?? []).map((u) => {
                    const alias = aliases.find((a) => a.alias_name === u.pool);
                    const spendCap = alias?.daily_spend_cap ?? 0;
                    const tokenCap = alias?.daily_token_cap ?? 0;
                    return (
                      <tr key={u.pool} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-3 px-4 text-white font-semibold font-sans">{u.pool}</td>
                        <td className="py-3 px-4 text-right text-slate-300">{u.requests}</td>
                        <td className="py-3 px-4 text-right text-slate-300">
                          {u.tokens.toLocaleString()}
                          {tokenCap > 0 && (
                            <span className={`ml-1 ${u.tokens >= tokenCap ? 'text-rose-400' : 'text-slate-400'}`}>
                              / {tokenCap.toLocaleString()}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <span className={spendCap > 0 && u.spend >= spendCap ? 'text-rose-400 font-bold' : 'text-emerald-400'}>
                            ${u.spend.toFixed(4)}
                          </span>
                          {spendCap > 0 && <span className="text-slate-400"> / ${spendCap}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-slate-900/60 rounded-xl border border-slate-800/80 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-800 flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-amber-400" />
            <h2 className="text-base font-semibold text-white">Gateway Keys Over Daily Budget</h2>
          </div>
          {(stats?.budgetedKeys ?? []).length === 0 ? (
            <div className="p-6 text-center text-slate-400 text-sm">
              No gateway key has exceeded its daily spend budget. 
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs font-mono">
                <thead>
                  <tr className="bg-slate-950/60 text-slate-400 border-b border-slate-800 uppercase tracking-wider text-[11px]">
                    <th className="py-3 px-4">Key</th>
                    <th className="py-3 px-4 text-right">Spend Today</th>
                    <th className="py-3 px-4 text-right">Budget Cap</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {(stats?.budgetedKeys ?? []).map((b) => (
                    <tr key={b.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-3 px-4 font-sans">
                        <div className="text-white font-semibold">{b.name}</div>
                        <div className="text-[10px] text-slate-400">{b.provider}</div>
                      </td>
                      <td className="py-3 px-4 text-right text-rose-400 font-bold">${b.spend_today.toFixed(4)}</td>
                      <td className="py-3 px-4 text-right text-slate-300">${b.daily_budget_cap.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Upstream Key Health Table */}
      <div className="bg-slate-900/60 rounded-xl border border-slate-800/80 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-indigo-400" />
            <h2 className="text-base font-semibold text-white">Upstream Key Health Pool</h2>
          </div>
          <span className="text-xs text-slate-400 font-mono">
            Rolling window: last 100 calls per key
          </span>
        </div>

        {keys.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-sm">
            No upstream API keys configured yet. Go to <strong className="text-slate-200">Upstream Keys</strong> to add keys.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="bg-slate-950/60 text-slate-400 border-b border-slate-800 uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-4">Provider / Key Name</th>
                  <th className="py-3 px-4">Masked Key</th>
                  <th className="py-3 px-4">Circuit State</th>
                  <th className="py-3 px-4">Success % (100)</th>
                  <th className="py-3 px-4">Latency (p50 / p95)</th>
                  <th className="py-3 px-4">RPM / Caps</th>
                  <th className="py-3 px-4">Last Error / Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {keys.map((k) => {
                  const cooldownText = formatCooldown(k.cooldown_until);
                  return (
                    <tr key={k.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-3 px-4 font-sans">
                        <div className="font-semibold text-white text-sm">{k.key_name}</div>
                        <div className="text-xs text-slate-400 font-mono">{k.provider_id}</div>
                      </td>

                      <td className="py-3 px-4 font-mono text-slate-300">
                        {k.masked_key}
                      </td>

                      <td className="py-3 px-4">
                        <div className="flex flex-col gap-1">
                          {k.circuit_state === 'CLOSED' && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 w-fit">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                              CLOSED
                            </span>
                          )}
                          {k.circuit_state === 'OPEN' && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20 w-fit">
                              <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse"></span>
                              OPEN
                            </span>
                          )}
                          {k.circuit_state === 'HALF_OPEN' && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20 w-fit">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                              HALF_OPEN
                            </span>
                          )}
                          {cooldownText && (
                            <span className="text-[10px] text-amber-400 flex items-center gap-1">
                              <Clock className="w-2.5 h-2.5" /> {cooldownText}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-4 font-mono">
                        <div className="flex items-center gap-2">
                          <div className="w-16 bg-slate-800 rounded-full h-2 overflow-hidden">
                            <div 
                              className={`h-full rounded-full ${
                                k.rolling_success_rate >= 90 ? 'bg-emerald-400' : k.rolling_success_rate >= 70 ? 'bg-amber-400' : 'bg-rose-400'
                              }`} 
                              style={{ width: `${k.rolling_success_rate}%` }}
                            />
                          </div>
                          <span className={k.rolling_success_rate >= 90 ? 'text-emerald-400 font-bold' : 'text-amber-400 font-bold'}>
                            {k.rolling_success_rate}%
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-400 block mt-0.5">
                          {k.total_calls_window} calls in window
                        </span>
                      </td>

                      <td className="py-3 px-4 font-mono text-slate-300">
                        {k.latency_p50 > 0 ? `${k.latency_p50}ms / ${k.latency_p95}ms` : '—'}
                      </td>

                      <td className="py-3 px-4 font-mono text-slate-300">
                        <div>RPM: <span className="text-white">{k.current_rpm}</span> / {k.rpm_cap > 0 ? k.rpm_cap : '∞'}</div>
                        <div className="text-[10px] text-slate-400">TPM: {k.current_tpm} / {k.tpm_cap > 0 ? k.tpm_cap : '∞'}</div>
                      </td>

                      <td className="py-3 px-4 max-w-xs truncate">
                        {k.disabled_reason ? (
                          <span className="text-rose-400 font-medium flex items-center gap-1">
                            <ShieldAlert className="w-3.5 h-3.5" />
                            {k.disabled_reason}
                          </span>
                        ) : k.last_error ? (
                          <span className="text-amber-400 truncate block" title={k.last_error}>
                            {k.last_error}
                          </span>
                        ) : (
                          <span className="text-slate-400">Healthy</span>
                        )}
                      </td>

                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleResetCircuit(k.id)}
                            disabled={resettingId === k.id}
                            title="Reset Circuit Breaker"
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                          >
                            <RotateCcw className={`w-3.5 h-3.5 ${resettingId === k.id ? 'animate-spin' : ''}`} />
                          </button>
                          <button
                            onClick={() => handleToggleKey(k)}
                            title={k.is_active ? 'Disable Key' : 'Enable Key'}
                            className={`p-1.5 rounded-lg transition-colors ${
                              k.is_active 
                                ? 'bg-slate-800 hover:bg-rose-900/30 text-emerald-400 hover:text-rose-400' 
                                : 'bg-rose-950/40 text-rose-400 hover:bg-emerald-950/40 hover:text-emerald-400'
                            }`}
                          >
                            <Power className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
