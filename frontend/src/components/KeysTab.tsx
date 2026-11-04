import React, { useState } from 'react';
import { 
  Plus, 
  Trash2, 
  RotateCcw, 
  Power, 
  Lock, 
  AlertTriangle
} from 'lucide-react';
import type { ApiKeyItem, Provider } from '../types';
import { addKey, updateKey, deleteKey, errorMessage } from '../api';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';

interface KeysTabProps {
  keys: ApiKeyItem[];
  providers: Provider[];
  onRefresh: () => void;
}

export const KeysTab: React.FC<KeysTabProps> = ({ keys, providers, onRefresh }) => {
  const [showAddModal, setShowAddModal] = useState(false);
  const [providerId, setProviderId] = useState(providers[0]?.id || '');
  const [keyName, setKeyName] = useState('');
  const [rawApiKey, setRawApiKey] = useState('');
  const [rpmCap, setRpmCap] = useState(0);
  const [tpmCap, setTpmCap] = useState(0);
  const [budgetCap, setBudgetCap] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ApiKeyItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!providerId || !keyName.trim() || !rawApiKey.trim()) {
      setErrorMsg('Please fill in provider, key name, and API key.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      await addKey({
        provider_id: providerId,
        key_name: keyName.trim(),
        api_key: rawApiKey.trim(),
        rpm_cap: Number(rpmCap) || 0,
        tpm_cap: Number(tpmCap) || 0,
        daily_budget_cap: Number(budgetCap) || 0,
      });
      setShowAddModal(false);
      setKeyName('');
      setRawApiKey('');
      setRpmCap(0);
      setTpmCap(0);
      setBudgetCap(0);
      onRefresh();
    } catch (err) {
      setErrorMsg(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggle = async (k: ApiKeyItem) => {
    await updateKey(k.id, { is_active: !k.is_active });
    onRefresh();
  };

  const handleReset = async (id: string) => {
    await updateKey(id, { reset_circuit: true });
    onRefresh();
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await deleteKey(pendingDelete.id);
      setPendingDelete(null);
      onRefresh();
    } catch (err) {
      setErrorMsg(errorMessage(err));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Add Button */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-2 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Upstream API Keys Pool</h1>
          <p className="text-sm text-slate-400">Keys are encrypted with AES-256-GCM at rest, masked in logs/UI, and rate-metered per key</p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-md shadow-indigo-500/20 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Upstream Key
        </button>
      </div>

      {/* Keys List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {keys.map((k) => (
          <div
            key={k.id}
            className={`p-5 rounded-xl border transition-all ${
              k.is_active 
                ? 'bg-slate-900/60 border-slate-800/80 hover:border-slate-700' 
                : 'bg-slate-950/40 border-slate-800/40 opacity-70'
            }`}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-white">{k.key_name}</h3>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                    k.is_active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-400'
                  }`}>
                    {k.is_active ? 'Active' : 'Disabled'}
                  </span>
                </div>
                <p className="text-xs text-indigo-400 font-mono mt-0.5">{k.provider_id}</p>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleReset(k.id)}
                  title="Reset Circuit"
                  aria-label={`Reset circuit for ${k.key_name}`}
                  className="min-h-6 min-w-6 inline-flex items-center justify-center p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleToggle(k)}
                  title={k.is_active ? 'Disable' : 'Enable'}
                  aria-label={`${k.is_active ? 'Disable' : 'Enable'} ${k.key_name}`}
                  className={`min-h-6 min-w-6 inline-flex items-center justify-center p-1.5 rounded-lg transition-colors ${
                    k.is_active ? 'bg-slate-800 hover:bg-rose-900/30 text-emerald-400 hover:text-rose-400' : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  <Power className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setPendingDelete(k)}
                  title="Delete Key"
                  aria-label={`Delete ${k.key_name}`}
                  className="min-h-6 min-w-6 inline-flex items-center justify-center p-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/30 text-slate-400 hover:text-rose-400 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Masked Key Pill */}
            <div className="mt-3 bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800 flex items-center justify-between text-xs font-mono text-slate-300">
              <span className="flex items-center gap-1.5">
                <Lock className="w-3 h-3 text-slate-400" />
                {k.masked_key}
              </span>
              <span className="text-[10px] text-slate-400 uppercase">AES-256-GCM</span>
            </div>

            {/* Health and Caps stats */}
            <div className="mt-4 pt-3 border-t border-slate-800/80 grid grid-cols-2 gap-2 text-xs font-mono">
              <div>
                <span className="text-[10px] text-slate-400 block uppercase">Circuit:</span>
                <span className={k.circuit_state === 'CLOSED' ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                  {k.circuit_state}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 block uppercase">Success Rate:</span>
                <span className="text-white font-semibold">{k.rolling_success_rate}%</span>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 block uppercase">RPM Cap:</span>
                <span className="text-slate-300">{k.current_rpm} / {k.rpm_cap > 0 ? k.rpm_cap : '∞'}</span>
              </div>
              <div>
                <span className="text-[10px] text-slate-400 block uppercase">TPM Cap:</span>
                <span className="text-slate-300">{k.current_tpm} / {k.tpm_cap > 0 ? k.tpm_cap : '∞'}</span>
              </div>
            </div>

            {k.last_error && (
              <div className="mt-2 text-[11px] text-rose-400 truncate bg-rose-950/20 px-2 py-1 rounded border border-rose-900/30">
                Last err: {k.last_error}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add Upstream Key Modal */}
      <Modal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add Encrypted Upstream Key"
        widthClassName="max-w-lg"
      >
        {errorMsg && (
          <div
            role="alert"
            className="text-xs text-rose-400 bg-rose-950/20 border border-rose-900/40 p-2.5 rounded-lg flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleAddKey} className="space-y-4">
          <div>
            <label htmlFor="key-provider" className="block text-xs font-semibold text-slate-300 mb-1">
              Target Provider:
            </label>
            <select
              id="key-provider"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="key-name" className="block text-xs font-semibold text-slate-300 mb-1">
              Key Friendly Name:
            </label>
            <input
              id="key-name"
              type="text"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="e.g. Production Groq Key #1"
              required
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="key-secret" className="block text-xs font-semibold text-slate-300 mb-1">
              Upstream Secret API Key:
            </label>
            <input
              id="key-secret"
              type="password"
              value={rawApiKey}
              onChange={(e) => setRawApiKey(e.target.value)}
              placeholder="Paste sk-... or api key here"
              required
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-white focus:border-indigo-500 focus:outline-none"
            />
            <span className="text-[10px] text-slate-400 block mt-1">
              Stored as AES-256-GCM cipher with master key. Never logged or exposed in plain text.
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="key-rpm" className="block text-xs font-semibold text-slate-300 mb-1">
                RPM Cap:
              </label>
              <input
                id="key-rpm"
                type="number"
                min={0}
                value={rpmCap}
                onChange={(e) => setRpmCap(parseInt(e.target.value, 10) || 0)}
                placeholder="0 = unlimited"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="key-tpm" className="block text-xs font-semibold text-slate-300 mb-1">
                TPM Cap:
              </label>
              <input
                id="key-tpm"
                type="number"
                min={0}
                value={tpmCap}
                onChange={(e) => setTpmCap(parseInt(e.target.value, 10) || 0)}
                placeholder="0 = unlimited"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="key-budget" className="block text-xs font-semibold text-slate-300 mb-1">
                Daily Cap ($):
              </label>
              <input
                id="key-budget"
                type="number"
                min={0}
                step="0.01"
                value={budgetCap}
                onChange={(e) => setBudgetCap(parseFloat(e.target.value) || 0)}
                placeholder="0 = none"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={() => setShowAddModal(false)}
              className="min-h-8 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="min-h-8 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-md transition-colors"
            >
              {isSubmitting ? 'Encrypting & Storing...' : 'Save Encrypted Key'}
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete upstream key?"
        message={
          <>
            KeyGate will stop routing to <span className="font-mono text-white">{pendingDelete?.key_name}</span> and
            remove the encrypted secret from the database. This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        destructive
        busy={isDeleting}
        onConfirm={() => { void handleDelete(); }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};
