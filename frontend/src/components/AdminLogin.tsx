import { useState, type FormEvent } from 'react';
import { KeyRound, ArrowRight, ShieldAlert } from 'lucide-react';
import { setAdminToken } from '../api';

interface AdminLoginProps {
  error: string | null;
  onAuthenticated: () => void;
}

export function AdminLogin({ error, onAuthenticated }: AdminLoginProps) {
  const [token, setToken] = useState('');

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    setAdminToken(trimmed);
    onAuthenticated();
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center font-sans px-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-11 h-11 rounded-xl bg-indigo-500/15 border border-indigo-500/40 flex items-center justify-center">
            <KeyRound className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">KeyGate</h1>
            <p className="text-xs text-slate-400">Management console</p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 shadow-xl shadow-black/40"
        >
          <h2 className="text-sm font-semibold text-slate-200">Admin token required</h2>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
            Enter the value of <code className="text-indigo-300">KEYGATE_ADMIN_TOKEN</code> to unlock
            providers, keys, routing and logs.
          </p>

          <label htmlFor="admin-token" className="block mt-5 text-xs font-medium text-slate-300">
            Admin token
          </label>
          <input
            id="admin-token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="kg-admin_..."
            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          />

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-px" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={!token.trim()}
            className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Unlock console
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-400">
          Token is stored in this browser only and sent as a Bearer header.
        </p>
      </div>
    </div>
  );
}
