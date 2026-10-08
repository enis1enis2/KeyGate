import React, { useState } from 'react';
import { 
  GitFork, 
  Plus, 
  Trash2, 
  ArrowRight, 
  Check,
  Wallet,
  Globe,
  Sparkles,
  X
} from 'lucide-react';
import type { ModelAlias, Provider, TargetConfig, EndpointKind, DashboardStats, TierConfig, SearchProviderId } from '../types';
import { ENDPOINT_KINDS, SEARCH_PROVIDERS } from '../types';
import { saveAlias, deleteAlias, errorMessage } from '../api';

interface RoutingTabProps {
  aliases: ModelAlias[];
  providers: Provider[];
  stats: DashboardStats | null;
  onRefresh: () => void;
}

export const RoutingTab: React.FC<RoutingTabProps> = ({ aliases, providers, stats, onRefresh }) => {
  const [selectedAlias, setSelectedAlias] = useState<ModelAlias | null>(aliases[0] || null);
  const [aliasName, setAliasName] = useState(aliases[0]?.alias_name || '');
  const [strategy, setStrategy] = useState<ModelAlias['strategy']>(
    aliases[0]?.strategy || 'weighted-by-health'
  );
  const [targets, setTargets] = useState<TargetConfig[]>(aliases[0]?.targets || []);
  const [hedgingEnabled, setHedgingEnabled] = useState(Boolean(aliases[0]?.hedging_enabled));
  const [hedgedDelayMs, setHedgedDelayMs] = useState(aliases[0]?.hedged_delay_ms || 500);
  const [timeoutMs, setTimeoutMs] = useState(aliases[0]?.timeout_ms || 30000);
  const [description, setDescription] = useState(aliases[0]?.description || '');
  const [endpointKind, setEndpointKind] = useState<EndpointKind>(aliases[0]?.endpoint_kind || 'chat');
  const [dailyTokenCap, setDailyTokenCap] = useState(aliases[0]?.daily_token_cap || 0);
  const [dailySpendCap, setDailySpendCap] = useState(aliases[0]?.daily_spend_cap || 0);

  const [searchEnabled, setSearchEnabled] = useState(Boolean(aliases[0]?.search_enabled));
  const [searchProvider, setSearchProvider] = useState<SearchProviderId>(
    (aliases[0]?.search_provider as SearchProviderId) || 'duckduckgo'
  );
  const [searchMaxResults, setSearchMaxResults] = useState(aliases[0]?.search_max_results || 3);
  const [searchMaxRounds, setSearchMaxRounds] = useState(aliases[0]?.search_max_rounds || 3);
  const [searchOffNotice, setSearchOffNotice] = useState(Boolean(aliases[0]?.search_off_notice));

  const [classifierProviderId, setClassifierProviderId] = useState(aliases[0]?.classifier_provider_id || '');
  const [classifierModel, setClassifierModel] = useState(aliases[0]?.classifier_model || '');
  const [tiers, setTiers] = useState<TierConfig[]>(aliases[0]?.tiers || []);

  const [isSaving, setIsSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const poolUsage = stats?.poolUsageToday ?? [];

  const usageFor = (poolName: string) =>
    poolUsage.find((u) => u.pool === poolName) ?? { pool: poolName, tokens: 0, spend: 0, requests: 0 };

  const applyPool = (a: ModelAlias | null) => {
    setSelectedAlias(a);
    setAliasName(a?.alias_name || '');
    setStrategy(a?.strategy || 'weighted-by-health');
    setTargets(a?.targets || []);
    setHedgingEnabled(Boolean(a?.hedging_enabled));
    setHedgedDelayMs(a?.hedged_delay_ms || 500);
    setTimeoutMs(a?.timeout_ms || 30000);
    setDescription(a?.description || '');
    setEndpointKind(a?.endpoint_kind || 'chat');
    setDailyTokenCap(a?.daily_token_cap || 0);
    setDailySpendCap(a?.daily_spend_cap || 0);
    setSearchEnabled(Boolean(a?.search_enabled));
    setSearchProvider((a?.search_provider as SearchProviderId) || 'duckduckgo');
    setSearchMaxResults(a?.search_max_results || 3);
    setSearchMaxRounds(a?.search_max_rounds || 3);
    setSearchOffNotice(Boolean(a?.search_off_notice));
    setClassifierProviderId(a?.classifier_provider_id || '');
    setClassifierModel(a?.classifier_model || '');
    setTiers(a?.tiers || []);
    setStatusMsg(null);
  };

  const handleSelectAlias = (a: ModelAlias) => applyPool(a);

  const handleAddTarget = () => {
    const defaultProvider = providers[0]?.id || '';
    setTargets([
      ...targets,
      { provider_id: defaultProvider, model: 'llama-3.3-70b-versatile', weight: 1, priority: targets.length + 1 },
    ]);
  };

  const handleUpdateTarget = (index: number, field: keyof TargetConfig, val: string | number | undefined) => {
    const updated = [...targets];
    if (!updated[index]) return;
    updated[index] = { ...updated[index], [field]: val };
    setTargets(updated);
  };

  const handleRemoveTarget = (index: number) => {
    setTargets(targets.filter((_, i) => i !== index));
  };

  const handleAddTier = () => {
    setTiers([...tiers, { name: `tier-${tiers.length + 1}`, description: '' }]);
  };

  const handleUpdateTier = (index: number, field: keyof TierConfig, value: string) => {
    const updated = [...tiers];
    if (!updated[index]) return;
    updated[index] = { ...updated[index], [field]: value };
    setTiers(updated);
  };

  const handleRemoveTier = (index: number) => {
    const removed = tiers[index]?.name;
    setTiers(tiers.filter((_, i) => i !== index));
    if (removed) {
      setTargets(targets.map((t) => (t.tier === removed ? { ...t, tier: undefined } : t)));
    }
  };

  const handleSave = async () => {
    if (!aliasName.trim()) {
      setStatusMsg('Pool name is required');
      return;
    }
    if (targets.length === 0) {
      setStatusMsg('At least one target provider is required in the chain');
      return;
    }
    if (strategy === 'by-ai' && !classifierProviderId && tiers.length === 0) {
      setStatusMsg('By-AI pools need either tier tags or a classifier model');
      return;
    }

    setIsSaving(true);
    setStatusMsg(null);
    try {
      await saveAlias({
        id: selectedAlias?.id,
        alias_name: aliasName.trim(),
        strategy,
        targets,
        hedging_enabled: hedgingEnabled,
        hedged_delay_ms: Number(hedgedDelayMs),
        timeout_ms: Number(timeoutMs),
        description: description.trim() || null,
        endpoint_kind: endpointKind,
        daily_token_cap: Number(dailyTokenCap) || 0,
        daily_spend_cap: Number(dailySpendCap) || 0,
        search_enabled: searchEnabled,
        search_provider: searchProvider,
        search_max_results: Number(searchMaxResults) || 3,
        search_max_rounds: Number(searchMaxRounds) || 3,
        search_off_notice: searchOffNotice,
        classifier_provider_id: classifierProviderId || null,
        classifier_model: classifierModel.trim() || null,
        tiers,
      });
      setStatusMsg('AI pool saved successfully!');
      onRefresh();
      setTimeout(() => setStatusMsg(null), 3000);
    } catch (err) {
      setStatusMsg(`Error: ${errorMessage(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this AI pool? Gateway keys scoped to it will stop working.')) return;
    await deleteAlias(id);
    onRefresh();
    if (selectedAlias?.id === id) applyPool(null);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-2 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">AI Pools & Failover Routing</h1>
          <p className="text-sm text-slate-400">A pool is the model name your clients send. It routes over a health-weighted target chain with failover, budgets, and speculative hedging.</p>
        </div>
        <button
          onClick={() => {
            applyPool(null);
            setAliasName('my-new-pool');
            setTargets([{ provider_id: providers[0]?.id || '', model: 'llama-3.3-70b-versatile', weight: 1, priority: 1 }]);
          }}
          className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-md shadow-indigo-500/20 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          Create New Pool
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Pools List */}
        <div className="lg:col-span-4 space-y-3">
          <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Configured Pools</h2>
          <div className="space-y-2">
            {aliases.length === 0 && (
              <div className="p-4 rounded-xl border border-dashed border-slate-800 text-xs text-slate-400 font-mono">
                No pools yet. Create one to expose a model name to your clients.
              </div>
            )}
            {aliases.map((a) => {
              const isSelected = selectedAlias?.id === a.id;
              const usage = usageFor(a.alias_name);
              return (
                <div
                  key={a.id}
                  onClick={() => handleSelectAlias(a)}
                  className={`p-4 rounded-xl border cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-slate-900 border-indigo-500/80 shadow-md shadow-indigo-500/10'
                      : 'bg-slate-900/60 border-slate-800/80 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-sm font-bold text-white flex items-center gap-2">
                        {a.alias_name}
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                          {a.endpoint_kind}
                        </span>
                      </div>
                      <div className="text-xs text-indigo-400 font-mono mt-0.5 flex items-center gap-2">
                        {a.strategy}
                        {Boolean(a.search_enabled) && (
                          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-sky-500/10 text-sky-300 border border-sky-500/20">
                            <Globe className="w-2.5 h-2.5" /> search
                          </span>
                        )}
                      </div>
                      {a.description && (
                        <div className="text-[11px] text-slate-400 mt-1 line-clamp-2">{a.description}</div>
                      )}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(a.id);
                      }}
                      className="text-slate-400 hover:text-rose-400 p-1.5 rounded transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Chain Preview */}
                  <div className="mt-3 flex flex-wrap gap-1.5 items-center">
                    {a.targets?.map((t, idx) => (
                      <React.Fragment key={idx}>
                        <span className="text-[11px] font-mono bg-slate-950 px-2 py-0.5 rounded border border-slate-800 text-slate-300">
                          {t.provider_id}:{t.model.slice(0, 15)}
                        </span>
                        {idx < a.targets.length - 1 && (
                          <ArrowRight className="w-3 h-3 text-slate-600" />
                        )}
                      </React.Fragment>
                    ))}
                  </div>

                  {/* Today's usage vs caps */}
                  <div className="mt-3 pt-2 border-t border-slate-800/70 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono">
                    <span className="text-slate-400">{usage.requests} req today</span>
                    <span className="text-slate-400">{usage.tokens.toLocaleString()} tok</span>
                    <span className={a.daily_spend_cap > 0 && usage.spend >= a.daily_spend_cap ? 'text-rose-400' : 'text-emerald-400'}>
                      ${usage.spend.toFixed(4)}
                      {a.daily_spend_cap > 0 && <span className="text-slate-400"> / ${a.daily_spend_cap}</span>}
                    </span>
                    {a.daily_token_cap > 0 && (
                      <span className={usage.tokens >= a.daily_token_cap ? 'text-rose-400' : 'text-slate-400'}>
                        cap {a.daily_token_cap.toLocaleString()} tok
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Pool Editor */}
        <div className="lg:col-span-8">
          <div className="bg-slate-900/60 rounded-xl border border-slate-800/80 p-5 space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <GitFork className="w-4 h-4 text-indigo-400" />
                <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                  Pool Configuration
                </h2>
              </div>
              <div className="flex items-center gap-3">
                {statusMsg && (
                  <span className={`text-xs ${statusMsg.startsWith('Error') ? 'text-rose-400' : 'text-emerald-400'} font-medium`}>
                    {statusMsg}
                  </span>
                )}
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
                >
                  <Check className="w-3.5 h-3.5" />
                  {isSaving ? 'Saving...' : 'Save Pool'}
                </button>
              </div>
            </div>

            {/* Pool Name & Strategy */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Pool Name (model):</label>
                <input
                  type="text"
                  value={aliasName}
                  onChange={(e) => setAliasName(e.target.value)}
                  placeholder="e.g. gpt-4o, code-fast, summarizer"
                  className="w-full bg-slate-950 text-white border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-[10px] text-slate-400 block mt-1">
                  Sent as the model parameter by any OpenAI-compatible client
                </span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Routing Strategy:</label>
                <select
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value as ModelAlias['strategy'])}
                  className="w-full bg-slate-950 text-white border border-slate-800 rounded-lg px-3 py-2 text-xs focus:border-indigo-500 focus:outline-none"
                >
                  <option value="weighted-by-health">weighted-by-health (Health score & latency p50)</option>
                  <option value="round-robin">round-robin (Even distribution among targets)</option>
                  <option value="priority">priority (Strict priority waterfall)</option>
                  <option value="by-ai">by-ai (Heuristic + classifier picks the model)</option>
                </select>
                <span className="text-[10px] text-slate-400 block mt-1">
                  {strategy === 'by-ai'
                    ? 'Simple requests go to the cheapest tier; hard ones go to the strongest model'
                    : 'Determines which healthy provider and key is chosen first'}
                </span>
              </div>
            </div>

            {/* Description & Endpoint Kind */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Description:</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder="What this pool is for, who may use it, ..."
                  className="w-full bg-slate-950 text-white border border-slate-800 rounded-lg px-3 py-2 text-xs focus:border-indigo-500 focus:outline-none resize-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Primary Endpoint:</label>
                <select
                  value={endpointKind}
                  onChange={(e) => setEndpointKind(e.target.value as EndpointKind)}
                  className="w-full bg-slate-950 text-white border border-slate-800 rounded-lg px-3 py-2 text-xs focus:border-indigo-500 focus:outline-none"
                >
                  {ENDPOINT_KINDS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
                <span className="text-[10px] text-slate-400 block mt-1">
                  Documentation hint only; every /v1 surface may use any pool
                </span>
              </div>
            </div>

            {/* Daily Budget Caps */}
            <div className="border-t border-slate-800 pt-4">
              <div className="flex items-center gap-2 mb-3">
                <Wallet className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Daily Pool Budget (UTC)</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Daily Token Cap (0 = unlimited):</label>
                  <input
                    type="number"
                    value={dailyTokenCap}
                    onChange={(e) => setDailyTokenCap(parseInt(e.target.value, 10) || 0)}
                    placeholder="0 = unlimited"
                    className="w-full bg-slate-950 text-white border border-slate-800 rounded px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Daily Spend Cap in USD (0 = unlimited):</label>
                  <input
                    type="number"
                    step="0.01"
                    value={dailySpendCap}
                    onChange={(e) => setDailySpendCap(parseFloat(e.target.value) || 0)}
                    placeholder="0.00 = unlimited"
                    className="w-full bg-slate-950 text-white border border-slate-800 rounded px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>
              <span className="text-[10px] text-slate-400 block mt-2">
                Checked before dispatch. Exhausting a cap answers new requests with <span className="font-mono text-amber-400">429 quota_exhausted</span>.
              </span>
            </div>

            {/* Online Web Search */}
            <div className="border-t border-slate-800 pt-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Globe className="w-3.5 h-3.5 text-sky-400" />
                  <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Online Web Search</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={searchEnabled}
                  onClick={() => setSearchEnabled(!searchEnabled)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    searchEnabled ? 'bg-indigo-600' : 'bg-slate-700'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      searchEnabled ? 'translate-x-4' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
              <p className="text-[11px] text-slate-400">
                When on, this model may request a live web search and the gateway feeds the results
                back before answering. Uses keyless backends (no API key needed).
              </p>

              {searchEnabled && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs mt-3">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Provider:</label>
                    <select
                      value={searchProvider}
                      onChange={(e) => setSearchProvider(e.target.value as SearchProviderId)}
                      className="w-full bg-slate-950 text-white border border-slate-800 rounded px-2.5 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
                    >
                      {SEARCH_PROVIDERS.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Results per search:</label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={searchMaxResults}
                      onChange={(e) => setSearchMaxResults(parseInt(e.target.value, 10) || 3)}
                      className="w-full bg-slate-950 text-white border border-slate-800 rounded px-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Max search rounds:</label>
                    <input
                      type="number"
                      min={0}
                      max={5}
                      value={searchMaxRounds}
                      onChange={(e) => setSearchMaxRounds(parseInt(e.target.value, 10) || 0)}
                      className="w-full bg-slate-950 text-white border border-slate-800 rounded px-2.5 py-1.5 text-xs"
                    />
                  </div>
                </div>
              )}

              <label className="flex items-center gap-2 mt-3 text-[11px] text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={searchOffNotice}
                  onChange={(e) => setSearchOffNotice(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950"
                />
                When search is off, tell the model to say that online access is disabled
              </label>
            </div>

            {/* By-AI selector (only relevant for the by-ai strategy) */}
            {strategy === 'by-ai' && (
              <div className="border-t border-slate-800 pt-4 space-y-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-fuchsia-400" />
                  <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">By-AI Model Selector</span>
                </div>
                <p className="text-[11px] text-slate-400">
                  A free heuristic scores each request first. When it is unsure, the optional classifier model below
                  chooses the tier (or the target when no tiers are tagged). The pick is only a preference — failover still applies.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Classifier provider (optional):</label>
                    <select
                      value={classifierProviderId}
                      onChange={(e) => setClassifierProviderId(e.target.value)}
                      className="w-full bg-slate-950 text-white border border-slate-800 rounded px-2.5 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
                    >
                      <option value="">None (heuristic only)</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Classifier model:</label>
                    <input
                      type="text"
                      value={classifierModel}
                      onChange={(e) => setClassifierModel(e.target.value)}
                      placeholder="e.g. gpt-4o-mini, llama-3.1-8b-instant"
                      className="w-full bg-slate-950 text-white border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Tiers</span>
                    <button
                      onClick={handleAddTier}
                      className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300"
                    >
                      <Plus className="w-3 h-3" /> Add tier
                    </button>
                  </div>
                  {tiers.length === 0 && (
                    <p className="text-[10px] text-slate-400 font-mono">
                      No tiers yet. Add tiers and tag each target below, or leave empty and let the classifier pick a target directly.
                    </p>
                  )}
                  {tiers.map((t, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={t.name}
                        onChange={(e) => handleUpdateTier(idx, 'name', e.target.value)}
                        placeholder="tier name (e.g. cheap, medium, strong)"
                        className="w-32 bg-slate-950 text-white border border-slate-800 rounded px-2 py-1 text-xs font-mono focus:border-indigo-500 focus:outline-none"
                      />
                      <input
                        type="text"
                        value={t.description || ''}
                        onChange={(e) => handleUpdateTier(idx, 'description', e.target.value)}
                        placeholder="description (optional)"
                        className="flex-1 bg-slate-950 text-white border border-slate-800 rounded px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none"
                      />
                      <button
                        onClick={() => handleRemoveTier(idx)}
                        className="text-slate-400 hover:text-rose-400 p-1"
                        aria-label="Remove tier"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Target Chain List */}
            <div className="space-y-3 pt-2 border-t border-slate-800">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                  Target Providers Chain (Failover Waterfall)
                </span>
                <button
                  onClick={handleAddTarget}
                  className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 font-semibold"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Target
                </button>
              </div>

              <div className="space-y-2">
                {targets.map((t, idx) => (
                  <div
                    key={idx}
                    className="flex flex-col sm:flex-row items-center gap-3 bg-slate-950 p-3 rounded-lg border border-slate-800 text-xs font-mono"
                  >
                    <div className="w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center font-bold text-slate-400 flex-shrink-0">
                      {idx + 1}
                    </div>

                    <div className="flex-1 w-full sm:w-auto">
                      <label className="block text-[10px] text-slate-400 uppercase mb-0.5">Provider</label>
                      <select
                        value={t.provider_id}
                        onChange={(e) => handleUpdateTarget(idx, 'provider_id', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                      >
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
                        ))}
                      </select>
                    </div>

                    <div className="flex-1 w-full sm:w-auto">
                      <label className="block text-[10px] text-slate-400 uppercase mb-0.5">Upstream Model</label>
                      <input
                        type="text"
                        value={t.model}
                        onChange={(e) => handleUpdateTarget(idx, 'model', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                      />
                    </div>

                    <div className="w-20">
                      <label className="block text-[10px] text-slate-400 uppercase mb-0.5">Weight</label>
                      <input
                        type="number"
                        value={t.weight}
                        onChange={(e) => handleUpdateTarget(idx, 'weight', parseInt(e.target.value, 10) || 1)}
                        className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                      />
                    </div>

                    <div className="w-20">
                      <label className="block text-[10px] text-slate-400 uppercase mb-0.5">Priority</label>
                      <input
                        type="number"
                        value={t.priority}
                        onChange={(e) => handleUpdateTarget(idx, 'priority', parseInt(e.target.value, 10) || 1)}
                        className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                      />
                    </div>

                    {strategy === 'by-ai' && tiers.length > 0 && (
                      <div className="w-28">
                        <label className="block text-[10px] text-slate-400 uppercase mb-0.5">Tier</label>
                        <select
                          value={t.tier || ''}
                          onChange={(e) => handleUpdateTarget(idx, 'tier', e.target.value || undefined)}
                          className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                        >
                          <option value="">untiered</option>
                          {tiers.map((tier) => (
                            <option key={tier.name} value={tier.name}>{tier.name}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    <button
                      onClick={() => handleRemoveTarget(idx)}
                      className="p-1.5 text-slate-400 hover:text-rose-400 rounded transition-colors self-end sm:self-center"
                      title="Remove Target"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Hedging & Timeout Advanced Controls */}
            <div className="border-t border-slate-800 pt-4 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="hedging"
                  checked={hedgingEnabled}
                  onChange={(e) => setHedgingEnabled(e.target.checked)}
                  className="rounded border-slate-800 bg-slate-950 text-indigo-600 focus:ring-0"
                />
                <label htmlFor="hedging" className="font-semibold text-slate-300">
                  Enable Hedged Requests
                </label>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Hedge Speculative Delay (ms):</label>
                <input
                  type="number"
                  value={hedgedDelayMs}
                  disabled={!hedgingEnabled}
                  onChange={(e) => setHedgedDelayMs(parseInt(e.target.value, 10) || 500)}
                  className="w-full bg-slate-950 text-white border border-slate-800 disabled:opacity-40 rounded px-2.5 py-1 text-xs"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Per-Request Timeout (ms):</label>
                <input
                  type="number"
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(parseInt(e.target.value, 10) || 30000)}
                  className="w-full bg-slate-950 text-white border border-slate-800 rounded px-2.5 py-1 text-xs"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
