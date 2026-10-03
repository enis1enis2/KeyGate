import React, { useState } from 'react';
import { 
  GitFork, 
  Plus, 
  Trash2, 
  ArrowRight, 
  Zap, 
  Sliders, 
  Clock, 
  ShieldCheck,
  Check
} from 'lucide-react';
import type { ModelAlias, Provider, TargetConfig } from '../types';
import { saveAlias, deleteAlias } from '../api';

interface RoutingTabProps {
  aliases: ModelAlias[];
  providers: Provider[];
  onRefresh: () => void;
}

export const RoutingTab: React.FC<RoutingTabProps> = ({ aliases, providers, onRefresh }) => {
  const [selectedAlias, setSelectedAlias] = useState<ModelAlias | null>(aliases[0] || null);
  const [aliasName, setAliasName] = useState(aliases[0]?.alias_name || '');
  const [strategy, setStrategy] = useState<'weighted-by-health' | 'round-robin' | 'priority'>(
    aliases[0]?.strategy || 'weighted-by-health'
  );
  const [targets, setTargets] = useState<TargetConfig[]>(aliases[0]?.targets || []);
  const [hedgingEnabled, setHedgingEnabled] = useState(Boolean(aliases[0]?.hedging_enabled));
  const [hedgedDelayMs, setHedgedDelayMs] = useState(aliases[0]?.hedged_delay_ms || 500);
  const [timeoutMs, setTimeoutMs] = useState(aliases[0]?.timeout_ms || 30000);

  const [isSaving, setIsSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const handleSelectAlias = (a: ModelAlias) => {
    setSelectedAlias(a);
    setAliasName(a.alias_name);
    setStrategy(a.strategy);
    setTargets(a.targets || []);
    setHedgingEnabled(Boolean(a.hedging_enabled));
    setHedgedDelayMs(a.hedged_delay_ms || 500);
    setTimeoutMs(a.timeout_ms || 30000);
    setStatusMsg(null);
  };

  const handleAddTarget = () => {
    const defaultProvider = providers[0]?.id || '';
    setTargets([
      ...targets,
      { provider_id: defaultProvider, model: 'llama-3.3-70b-versatile', weight: 1, priority: targets.length + 1 },
    ]);
  };

  const handleUpdateTarget = (index: number, field: keyof TargetConfig, val: any) => {
    const updated = [...targets];
    if (!updated[index]) return;
    updated[index] = { ...updated[index], [field]: val };
    setTargets(updated);
  };

  const handleRemoveTarget = (index: number) => {
    setTargets(targets.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!aliasName.trim()) {
      setStatusMsg('Alias name is required');
      return;
    }
    if (targets.length === 0) {
      setStatusMsg('At least one target provider is required in the chain');
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
      });
      setStatusMsg('Alias routing saved successfully!');
      onRefresh();
      setTimeout(() => setStatusMsg(null), 3000);
    } catch (err: any) {
      setStatusMsg(`Error: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this model alias?')) return;
    await deleteAlias(id);
    onRefresh();
    if (selectedAlias?.id === id) {
      setSelectedAlias(null);
      setAliasName('');
      setTargets([]);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-2 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Model Aliases & Failover Routing</h1>
          <p className="text-sm text-slate-400">Configure target chains with health-weighted routing, failovers, and speculative hedging</p>
        </div>
        <button
          onClick={() => {
            setSelectedAlias(null);
            setAliasName('my-new-alias');
            setStrategy('weighted-by-health');
            setTargets([{ provider_id: providers[0]?.id || '', model: 'llama-3.3-70b-versatile', weight: 1, priority: 1 }]);
            setHedgingEnabled(false);
            setHedgedDelayMs(500);
            setTimeoutMs(30000);
          }}
          className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-md shadow-indigo-500/20 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          Create New Alias
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Aliases List */}
        <div className="lg:col-span-4 space-y-3">
          <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Configured Aliases</h2>
          <div className="space-y-2">
            {aliases.map((a) => {
              const isSelected = selectedAlias?.id === a.id;
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
                      </div>
                      <div className="text-xs text-indigo-400 font-mono mt-0.5">{a.strategy}</div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(a.id);
                      }}
                      className="text-slate-500 hover:text-rose-400 p-1 rounded transition-colors"
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
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Routing Editor */}
        <div className="lg:col-span-8">
          <div className="bg-slate-900/60 rounded-xl border border-slate-800/80 p-5 space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <GitFork className="w-4 h-4 text-indigo-400" />
                <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                  Routing Chain Configuration
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
                  {isSaving ? 'Saving...' : 'Save Routing'}
                </button>
              </div>
            </div>

            {/* Alias Name & Strategy */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Model Alias Name:</label>
                <input
                  type="text"
                  value={aliasName}
                  onChange={(e) => setAliasName(e.target.value)}
                  placeholder="e.g. gpt-4o, code-fast, summarizer"
                  className="w-full bg-slate-950 text-white border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-[10px] text-slate-500 block mt-1">
                  Exposed to n8n and clients via /v1/chat/completions (model parameter)
                </span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Routing Strategy:</label>
                <select
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value as any)}
                  className="w-full bg-slate-950 text-white border border-slate-800 rounded-lg px-3 py-2 text-xs focus:border-indigo-500 focus:outline-none"
                >
                  <option value="weighted-by-health">weighted-by-health (Health score & latency p50)</option>
                  <option value="round-robin">round-robin (Even distribution among targets)</option>
                  <option value="priority">priority (Strict priority waterfall)</option>
                </select>
                <span className="text-[10px] text-slate-500 block mt-1">
                  Determines which healthy provider and key is chosen first
                </span>
              </div>
            </div>

            {/* Target Chain List */}
            <div className="space-y-3 pt-2">
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
                      <label className="block text-[10px] text-slate-500 uppercase mb-0.5">Provider</label>
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
                      <label className="block text-[10px] text-slate-500 uppercase mb-0.5">Upstream Model</label>
                      <input
                        type="text"
                        value={t.model}
                        onChange={(e) => handleUpdateTarget(idx, 'model', e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                      />
                    </div>

                    <div className="w-20">
                      <label className="block text-[10px] text-slate-500 uppercase mb-0.5">Weight</label>
                      <input
                        type="number"
                        value={t.weight}
                        onChange={(e) => handleUpdateTarget(idx, 'weight', parseInt(e.target.value, 10) || 1)}
                        className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                      />
                    </div>

                    <div className="w-20">
                      <label className="block text-[10px] text-slate-500 uppercase mb-0.5">Priority</label>
                      <input
                        type="number"
                        value={t.priority}
                        onChange={(e) => handleUpdateTarget(idx, 'priority', parseInt(e.target.value, 10) || 1)}
                        className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-200"
                      />
                    </div>

                    <button
                      onClick={() => handleRemoveTarget(idx)}
                      className="p-1.5 text-slate-500 hover:text-rose-400 rounded transition-colors self-end sm:self-center"
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
