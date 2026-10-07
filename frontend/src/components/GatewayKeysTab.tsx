import React, { useState } from 'react';
import { 
  Lock, 
  Plus, 
  Trash2, 
  Copy, 
  Check, 
  ShieldCheck, 
  BookOpen
} from 'lucide-react';
import type { GatewayKey, ModelAlias } from '../types';
import { createGatewayKey, revokeGatewayKey, deleteGatewayKey, errorMessage } from '../api';

interface GatewayKeysTabProps {
  gatewayKeys: GatewayKey[];
  aliases: ModelAlias[];
  onRefresh: () => void;
}

export const GatewayKeysTab: React.FC<GatewayKeysTabProps> = ({ gatewayKeys, aliases, onRefresh }) => {
  const [showAddModal, setShowAddModal] = useState(false);
  const [name, setName] = useState('');
  const [rpmLimit, setRpmLimit] = useState(0);
  const [tpmLimit, setTpmLimit] = useState(0);
  const [expiresInDays, setExpiresInDays] = useState(0);
  const [allowedPools, setAllowedPools] = useState<string[]>([]);

  // One-time token reveal modal
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const togglePool = (pool: string) => {
    setAllowedPools((prev) =>
      prev.includes(pool) ? prev.filter((p) => p !== pool) : [...prev, pool]
    );
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setIsSubmitting(true);
    try {
      const res = await createGatewayKey({
        name: name.trim(),
        rpm_limit: Number(rpmLimit) || 0,
        tpm_limit: Number(tpmLimit) || 0,
        expires_in_days: expiresInDays > 0 ? Number(expiresInDays) : undefined,
        allowed_aliases: allowedPools.length > 0 ? allowedPools : undefined,
      });
      setNewlyCreatedToken(res.token);
      setShowAddModal(false);
      setName('');
      setRpmLimit(0);
      setTpmLimit(0);
      setExpiresInDays(0);
      setAllowedPools([]);
      onRefresh();
    } catch (err) {
      alert(`Error creating token: ${errorMessage(err)}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRevoke = async (id: string) => {
    if (!confirm('Are you sure you want to revoke this Gateway key?')) return;
    await revokeGatewayKey(id);
    onRefresh();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this Gateway key?')) return;
    await deleteGatewayKey(id);
    onRefresh();
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Header & Add Button */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-2 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Gateway Bearer Keys</h1>
          <p className="text-sm text-slate-400">Issue authorized Bearer tokens for agents, apps, and any OpenAI-compatible client</p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-md shadow-indigo-500/20 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          Generate Gateway Key
        </button>
      </div>

      {/* Quick Integration Banner */}
      <div className="bg-gradient-to-r from-indigo-950/40 via-purple-950/30 to-slate-900 border border-indigo-500/30 rounded-xl p-5 shadow-lg space-y-3">
        <div className="flex items-center gap-2 text-indigo-400">
          <BookOpen className="w-5 h-5" />
          <h2 className="text-sm font-bold text-white uppercase tracking-wider">
            Quick Integration: Point Any OpenAI Client Here
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
          <div className="bg-slate-950/70 p-3 rounded-lg border border-slate-800 space-y-1">
            <span className="text-slate-500 block uppercase text-[10px]">OpenAI SDK / LangChain / n8n:</span>
            <div className="text-slate-300">API Key: <span className="text-indigo-400">Your Gateway Key (kg-live-...)</span></div>
            <div className="text-slate-300">Base URL: <span className="text-emerald-400">http://keygate:3000/v1</span></div>
          </div>
          <div className="bg-slate-950/70 p-3 rounded-lg border border-slate-800 space-y-1">
            <span className="text-slate-500 block uppercase text-[10px]">Generic Passthrough HTTP:</span>
            <div className="text-slate-300">URL: <span className="text-cyan-400">http://keygate:3000/v1/passthrough/{"{provider}"}/*</span></div>
            <div className="text-slate-300">Header: <span className="text-slate-400">Authorization: Bearer kg-live-...</span></div>
          </div>
        </div>
      </div>

      {/* Keys List */}
      <div className="bg-slate-900/60 rounded-xl border border-slate-800/80 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-indigo-400" />
            <h2 className="text-sm font-bold text-white uppercase tracking-wider">Issued Gateway Tokens</h2>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs font-mono">
            <thead>
              <tr className="bg-slate-950/60 text-slate-400 border-b border-slate-800 uppercase tracking-wider text-[11px]">
                <th className="py-3 px-4">Key Name</th>
                <th className="py-3 px-4">Masked Token</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Rate Limits</th>
                <th className="py-3 px-4">Pool Scope</th>
                <th className="py-3 px-4">Created</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {gatewayKeys.map((k) => (
                <tr key={k.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-3 px-4 font-sans font-semibold text-white">
                    {k.name}
                  </td>
                  <td className="py-3 px-4 text-slate-300 font-mono">
                    {k.masked_token}
                  </td>
                  <td className="py-3 px-4">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                      k.is_active 
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                        : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                    }`}>
                      {k.is_active ? 'Active' : 'Revoked'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-slate-400">
                    RPM: {k.rpm_limit > 0 ? k.rpm_limit : '∞'} | TPM: {k.tpm_limit > 0 ? k.tpm_limit : '∞'}
                  </td>
                  <td className="py-3 px-4">
                    {k.allowed_aliases.includes('*') || k.allowed_aliases.length === 0 ? (
                      <span className="text-slate-500">All pools</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {k.allowed_aliases.map((p) => (
                          <span
                            key={p}
                            className="px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 text-[10px] font-semibold"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-4 text-slate-500">
                    {new Date(k.created_at).toLocaleDateString()}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {k.is_active && (
                        <button
                          onClick={() => handleRevoke(k.id)}
                          className="px-2.5 py-1 rounded bg-slate-800 hover:bg-rose-900/40 text-slate-300 hover:text-rose-400 text-xs transition-colors"
                        >
                          Revoke
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(k.id)}
                        className="p-1 rounded text-slate-500 hover:text-rose-400 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Token Reveal Modal */}
      {newlyCreatedToken && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-emerald-500/40 rounded-xl max-w-lg w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-2 text-emerald-400">
              <ShieldCheck className="w-6 h-6" />
              <h2 className="text-base font-bold text-white">Save Your Gateway Token Now</h2>
            </div>
            <p className="text-xs text-slate-300">
              This is the only time this token will ever be displayed in plain text. Please copy it and save it in your OpenAI credential or password vault.
            </p>

            <div className="bg-slate-950 p-3 rounded-lg border border-slate-800 flex items-center justify-between font-mono text-xs text-emerald-400 break-all">
              <span>{newlyCreatedToken}</span>
              <button
                onClick={() => handleCopy(newlyCreatedToken)}
                className="ml-3 p-1.5 rounded bg-slate-800 hover:bg-slate-700 text-white flex-shrink-0"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setNewlyCreatedToken(null)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-md transition-colors"
              >
                I Have Safely Saved It
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Generate Token Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Lock className="w-5 h-5 text-indigo-400" />
                <h2 className="text-base font-bold text-white">Generate Gateway Bearer Token</h2>
              </div>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-white">&times;</button>
            </div>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Key Name / Client ID:</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Production AI Agent"
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">RPM Limit:</label>
                  <input
                    type="number"
                    value={rpmLimit}
                    onChange={(e) => setRpmLimit(parseInt(e.target.value, 10) || 0)}
                    placeholder="0 = unlimited"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">Expires In (Days):</label>
                  <input
                    type="number"
                    value={expiresInDays}
                    onChange={(e) => setExpiresInDays(parseInt(e.target.value, 10) || 0)}
                    placeholder="0 = never"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">TPM Limit:</label>
                <input
                  type="number"
                  value={tpmLimit}
                  onChange={(e) => setTpmLimit(parseInt(e.target.value, 10) || 0)}
                  placeholder="0 = unlimited"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Pool Scope {allowedPools.length > 0 ? `(${allowedPools.length} selected)` : ''}
                </label>
                <div className="max-h-40 overflow-y-auto border border-slate-800 rounded-lg p-2 space-y-1 bg-slate-950">
                  <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowedPools.length === 0}
                      onChange={() => setAllowedPools([])}
                      className="rounded border-slate-800 bg-slate-950 text-indigo-600 focus:ring-0"
                    />
                    All pools (unrestricted)
                  </label>
                  {aliases.length === 0 ? (
                    <div className="text-[11px] text-slate-500 px-1 py-1">No pools defined yet — create one under AI Pools.</div>
                  ) : (
                    aliases.map((a) => (
                      <label key={a.id} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={allowedPools.includes(a.alias_name)}
                          onChange={() => togglePool(a.alias_name)}
                          className="rounded border-slate-800 bg-slate-950 text-indigo-600 focus:ring-0"
                        />
                        <span className="font-mono">{a.alias_name}</span>
                      </label>
                    ))
                  )}
                </div>
                <span className="text-[10px] text-slate-500 block mt-1">
                  Requests for a pool outside this scope are rejected with <span className="font-mono text-rose-400">403 model_not_allowed</span>
                </span>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 bg-slate-800 text-slate-300 text-xs font-semibold rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-md"
                >
                  {isSubmitting ? 'Generating...' : 'Generate Token'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
