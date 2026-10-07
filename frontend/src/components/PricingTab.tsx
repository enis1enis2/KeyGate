import React, { useState, useEffect } from 'react';
import { DollarSign, Plus, Trash2 } from 'lucide-react';
import type { ModelPricing, Provider } from '../types';
import { fetchPricing, savePricing, deletePricing, errorMessage } from '../api';

interface PricingTabProps {
  providers: Provider[];
  onRefresh: () => void;
}

export const PricingTab: React.FC<PricingTabProps> = ({ providers, onRefresh }) => {
  const [rows, setRows] = useState<ModelPricing[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [inputPerMtok, setInputPerMtok] = useState('');
  const [outputPerMtok, setOutputPerMtok] = useState('');

  const [isSaving, setIsSaving] = useState(false);

  const load = async () => {
    setIsLoading(true);
    try {
      const data = await fetchPricing();
      setRows(data);
    } catch (err) {
      setStatusMsg(`Error: ${errorMessage(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async () => {
    const input = Number(inputPerMtok);
    const output = Number(outputPerMtok);
    if (!providerId.trim() || !model.trim()) {
      setStatusMsg('Provider and model are required');
      return;
    }
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
      setStatusMsg('Prices must be non-negative numbers');
      return;
    }

    setIsSaving(true);
    setStatusMsg(null);
    try {
      await savePricing({
        provider_id: providerId.trim(),
        model: model.trim(),
        input_per_mtok: input,
        output_per_mtok: output,
      });
      setStatusMsg('Pricing saved');
      setModel('');
      setInputPerMtok('');
      setOutputPerMtok('');
      await load();
      onRefresh();
      setTimeout(() => setStatusMsg(null), 3000);
    } catch (err) {
      setStatusMsg(`Error: ${errorMessage(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this pricing row? Requests matching it will no longer incur cost.')) return;
    await deletePricing(id);
    await load();
    onRefresh();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-2 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Model Pricing</h1>
          <p className="text-sm text-slate-400">
            USD per million tokens. Matched most-specific first: <span className="font-mono text-indigo-400">provider_id + model</span>, then <span className="font-mono text-indigo-400">provider + *</span>, then <span className="font-mono text-indigo-400">* + model</span>, then <span className="font-mono text-indigo-400">* + *</span>.
          </p>
        </div>
        <span className="text-xs font-mono text-slate-500">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
      </div>

      {/* Add / Edit form */}
      <div className="bg-slate-900/60 rounded-xl border border-slate-800/80 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Add Pricing Row</h2>
          </div>
          {statusMsg && (
            <span className={`text-xs font-medium ${statusMsg.startsWith('Error') ? 'text-rose-400' : 'text-emerald-400'}`}>
              {statusMsg}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Provider:</label>
            <select
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              className="w-full bg-slate-950 text-white border border-slate-800 rounded px-2.5 py-2 font-mono focus:border-indigo-500 focus:outline-none"
            >
              <option value="">Select provider…</option>
              <option value="*">* (any provider)</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Model (or * for any):</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="* or gpt-4o-mini"
              className="w-full bg-slate-950 text-white border border-slate-800 rounded px-2.5 py-2 font-mono focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Input $ / Mtok:</label>
            <input
              type="number"
              step="0.01"
              value={inputPerMtok}
              onChange={(e) => setInputPerMtok(e.target.value)}
              placeholder="0.00"
              className="w-full bg-slate-950 text-white border border-slate-800 rounded px-2.5 py-2 font-mono focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-[11px] text-slate-400 mb-1">Output $ / Mtok:</label>
            <input
              type="number"
              step="0.01"
              value={outputPerMtok}
              onChange={(e) => setOutputPerMtok(e.target.value)}
              placeholder="0.00"
              className="w-full bg-slate-950 text-white border border-slate-800 rounded px-2.5 py-2 font-mono focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg shadow-md shadow-emerald-500/20 transition-all disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            {isSaving ? 'Saving…' : 'Save Pricing'}
          </button>
        </div>
      </div>

      {/* Pricing table */}
      <div className="bg-slate-900/60 rounded-xl border border-slate-800/80 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold text-white">Configured Prices</h2>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-slate-400 text-sm font-mono">Loading pricing…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-sm">
            No pricing rows yet. Requests still succeed — they are simply not metered for cost until you add one.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="bg-slate-950/60 text-slate-400 border-b border-slate-800 uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-4">Provider</th>
                  <th className="py-3 px-4">Model</th>
                  <th className="py-3 px-4 text-right">Input $/Mtok</th>
                  <th className="py-3 px-4 text-right">Output $/Mtok</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 px-4 text-slate-300">{r.provider_id}</td>
                    <td className="py-3 px-4 text-white">{r.model}</td>
                    <td className="py-3 px-4 text-right text-slate-300">{r.input_per_mtok.toFixed(4)}</td>
                    <td className="py-3 px-4 text-right text-slate-300">{r.output_per_mtok.toFixed(4)}</td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => handleDelete(r.id)}
                        className="p-1.5 text-slate-500 hover:text-rose-400 rounded transition-colors"
                        title="Delete Pricing"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
