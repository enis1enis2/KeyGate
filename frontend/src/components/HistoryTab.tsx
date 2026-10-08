import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  RefreshCw, 
  Radio, 
  Trash2, 
  MessageSquare, 
  User, 
  Bot,
  Braces
} from 'lucide-react';
import type { ChatHistoryEntry, HistoryPoolSummary } from '../types';
import { clearHistory, deleteHistoryEntry, fetchHistory } from '../api';

interface HistoryTabProps {
  /** Pool names available from the current alias list (used to seed the selector). */
  poolNames?: string[];
}

interface HistoryGroup {
  trace_id: string;
  created_at: string;
  user: ChatHistoryEntry | null;
  assistant: ChatHistoryEntry | null;
  pool_name: string;
  model: string;
  is_stream: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export const HistoryTab: React.FC<HistoryTabProps> = ({ poolNames }) => {
  const [allEntries, setAllEntries] = useState<ChatHistoryEntry[]>([]);
  const [pools, setPools] = useState<HistoryPoolSummary[]>([]);
  const [selectedPool, setSelectedPool] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(() => {
    return fetchHistory(selectedPool || undefined)
      .then((data) => {
        setAllEntries(data.entries);
        setPools(data.pools);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load history');
      });
  }, [selectedPool]);

  const handleRefresh = () => {
    setIsLoading(true);
    void fetchPage().finally(() => setIsLoading(false));
  };

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      void fetchPage();
    }, 6000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchPage]);

  // Seed the pool selector from history first, then fall back to the alias list.
  const orderedPools = pools.length > 0
    ? pools.map((p) => p.pool_name)
    : (poolNames?.filter((n) => n) || []);

  const groups = useMemo<HistoryGroup[]>(() => {
    const byTrace = new Map<string, HistoryGroup>();
    for (const entry of allEntries) {
      let group = byTrace.get(entry.trace_id);
      if (!group) {
        group = { trace_id: entry.trace_id, created_at: entry.created_at, user: null, assistant: null, pool_name: entry.pool_name, model: entry.model, is_stream: entry.is_stream, prompt_tokens: 0, completion_tokens: 0 };
        byTrace.set(entry.trace_id, group);
      }
      if (entry.role === 'user') group.user = entry;
      if (entry.role === 'assistant') group.assistant = entry;
      group.pool_name = entry.pool_name;
      group.model = entry.model;
      group.is_stream = entry.is_stream;
      group.prompt_tokens = entry.prompt_tokens;
      group.completion_tokens = entry.completion_tokens;
    }
    return Array.from(byTrace.values()).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [allEntries]);

  const handleClearPool = async () => {
    if (!selectedPool) return;
    if (!window.confirm(`Clear all history for pool "${selectedPool}"?`)) return;
    await clearHistory(selectedPool);
    void fetchPage();
  };

  const handleDeleteTrace = async (group: HistoryGroup) => {
    const ids = [group.user?.id, group.assistant?.id].filter((id): id is string => Boolean(id));
    await Promise.all(ids.map((id) => deleteHistoryEntry(id)));
    void fetchPage();
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-2 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Chat Message History</h1>
          <p className="text-sm text-slate-400">
            Per-pool prompt/answer timeline — shows which model sent or received each message. Request plumbing is never stored.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <select
            value={selectedPool}
            onChange={(e) => setSelectedPool(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-200 min-w-[160px]"
          >
            <option value="">All Pools</option>
            {orderedPools.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
              autoRefresh
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}
          >
            <Radio className={`w-3 h-3 ${autoRefresh ? 'animate-pulse' : ''}`} />
            {autoRefresh ? 'Live' : 'Paused'}
          </button>
          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          {selectedPool && (
            <button
              onClick={() => void handleClearPool()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-xs font-semibold rounded-lg border border-rose-500/30 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear Pool
            </button>
          )}
        </div>
      </div>

      {/* Pool count strip */}
      {pools.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pools.map((p) => (
            <button
              key={p.pool_name}
              onClick={() => setSelectedPool(selectedPool === p.pool_name ? '' : p.pool_name)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-mono border transition-colors ${
                selectedPool === p.pool_name
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {p.pool_name} <span className="opacity-60">({p.count})</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 rounded-lg px-4 py-2.5 text-xs font-mono">
          {error}
        </div>
      )}

      {/* Timeline */}
      {groups.length === 0 ? (
        <div className="bg-slate-900/60 rounded-xl border border-slate-800/80 p-10 text-center text-slate-400 text-xs font-mono">
          No recorded messages yet. Send a chat in the Playground and the prompt/answer pair will show up here per pool.
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.trace_id} className="bg-slate-900/60 rounded-xl border border-slate-800/80 overflow-hidden">
              {/* Trace header */}
              <div className="flex items-center justify-between px-4 py-2 bg-slate-950/60 border-b border-slate-800/60 text-[10px] font-mono text-slate-500">
                <div className="flex items-center gap-3 whitespace-nowrap overflow-hidden">
                  <span>{new Date(group.created_at).toLocaleString()}</span>
                  <span className="text-indigo-400 truncate">{group.trace_id.slice(0, 16)}…</span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">{group.pool_name}</span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-cyan-300">{group.model}</span>
                  {group.is_stream ? (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                      <Radio className="w-2.5 h-2.5 inline" /> SSE
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400">JSON</span>
                  )}
                  {group.prompt_tokens + group.completion_tokens > 0 && (
                    <span>{group.prompt_tokens} &rarr; {group.completion_tokens} tok</span>
                  )}
                </div>
                <button
                  onClick={() => void handleDeleteTrace(group)}
                  className="text-slate-500 hover:text-rose-400 transition-colors"
                  title="Delete this exchange"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Messages */}
              <div className="px-4 py-3 space-y-3">
                {group.user?.content != null ? (
                  <div className="flex justify-end">
                    <div className="max-w-[75%] bg-indigo-600/90 text-white rounded-lg rounded-tr-none px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words">
                      <span className="block text-[9px] uppercase tracking-wider text-indigo-200 mb-1 flex items-center gap-1">
                        <User className="w-2.5 h-2.5" /> Prompt
                      </span>
                      {group.user.content}
                    </div>
                  </div>
                ) : (
                  <div className="text-[11px] text-slate-500 italic font-mono">user message not captured</div>
                )}

                {group.assistant?.content != null ? (
                  <div className="flex justify-start">
                    <div className="max-w-[75%] bg-slate-800 border border-slate-700/60 text-slate-100 rounded-lg rounded-tl-none px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words">
                      <span className="block text-[9px] uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-1">
                        <Bot className="w-2.5 h-2.5" /> Answer &middot; {group.model}
                      </span>
                      {group.assistant.content}
                    </div>
                  </div>
                ) : (
                  <div className="text-[11px] text-slate-500 italic font-mono">assistant answer not captured</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state hint icons */}
      {groups.length > 0 && (
        <div className="flex items-center justify-center gap-2 text-[11px] text-slate-500 font-mono">
          <MessageSquare className="w-3.5 h-3.5" />
          <Braces className="w-3.5 h-3.5" />
          Only message text is retained — headers, raw request bodies and secrets are never stored.
        </div>
      )}
    </div>
  );
};