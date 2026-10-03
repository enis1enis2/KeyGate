import React, { useState, useEffect } from 'react';
import { 
  FileText, 
  Search, 
  Filter, 
  RefreshCw, 
  CheckCircle2, 
  AlertTriangle, 
  Eye, 
  Radio
} from 'lucide-react';
import type { RequestLog, Provider } from '../types';
import { fetchLogs } from '../api';

interface LogsTabProps {
  providers: Provider[];
}

export const LogsTab: React.FC<LogsTabProps> = ({ providers }) => {
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedLog, setSelectedLog] = useState<RequestLog | null>(null);

  const loadLogs = async () => {
    setIsLoading(true);
    try {
      const data = await fetchLogs({
        status: statusFilter || undefined,
        provider_id: providerFilter || undefined,
        model: modelFilter || undefined,
        limit: 100,
      });
      setLogs(data);
    } catch (err) {
      console.error('Failed to load logs:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
  }, [statusFilter, providerFilter, modelFilter]);

  // Auto-refresh interval
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      loadLogs();
    }, 4000);
    return () => clearInterval(interval);
  }, [autoRefresh, statusFilter, providerFilter, modelFilter]);

  return (
    <div className="space-y-6">
      {/* Header and Filter Controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-2 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Live Request Trace Logs</h1>
          <p className="text-sm text-slate-400">Inspecting request latency, upstream keys used, token counts, and error classifications</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
              autoRefresh 
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' 
                : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}
          >
            <Radio className={`w-3 h-3 ${autoRefresh ? 'animate-pulse' : ''}`} />
            {autoRefresh ? 'Live Streaming' : 'Paused'}
          </button>
          <button
            onClick={loadLogs}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-800/80 flex flex-wrap gap-4 text-xs font-mono">
        <div className="flex-1 min-w-[140px]">
          <label className="block text-[10px] text-slate-500 uppercase mb-1">Status Filter:</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200"
          >
            <option value="">All Statuses</option>
            <option value="success">Success Only</option>
            <option value="error">Errors Only</option>
          </select>
        </div>

        <div className="flex-1 min-w-[140px]">
          <label className="block text-[10px] text-slate-500 uppercase mb-1">Provider:</label>
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200"
          >
            <option value="">All Providers</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="flex-1 min-w-[160px]">
          <label className="block text-[10px] text-slate-500 uppercase mb-1">Model Search:</label>
          <input
            type="text"
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            placeholder="e.g. gpt-4o"
            className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200"
          />
        </div>
      </div>

      {/* Logs Table */}
      <div className="bg-slate-900/60 rounded-xl border border-slate-800/80 overflow-hidden">
        {logs.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-xs font-mono">
            No request logs matching selected filters. Send a chat completion request to see live traces.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="bg-slate-950/60 text-slate-400 border-b border-slate-800 uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-4">Time</th>
                  <th className="py-3 px-4">Alias / Model</th>
                  <th className="py-3 px-4">Provider</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Latency</th>
                  <th className="py-3 px-4">Tokens</th>
                  <th className="py-3 px-4">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 px-4 text-slate-400 whitespace-nowrap">
                      {new Date(log.created_at).toLocaleTimeString()}
                    </td>
                    <td className="py-3 px-4 font-semibold text-white whitespace-nowrap">
                      <div>{log.alias_name || log.model}</div>
                      {log.alias_name && log.alias_name !== log.model && (
                        <div className="text-[10px] text-slate-500">{log.model}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-indigo-400 whitespace-nowrap">
                      {log.provider_id}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      {log.status === 'success' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          <CheckCircle2 className="w-3 h-3" />
                          {log.status_code} OK
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">
                          <AlertTriangle className="w-3 h-3" />
                          {log.status_code} {log.error_type || 'ERR'}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-300 whitespace-nowrap">
                      {log.latency_ms}ms
                    </td>
                    <td className="py-3 px-4 text-slate-400 whitespace-nowrap">
                      {log.prompt_tokens + log.completion_tokens > 0 ? (
                        <span>{log.prompt_tokens} &rarr; {log.completion_tokens}</span>
                      ) : (
                        <span>—</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <button
                        onClick={() => setSelectedLog(log)}
                        className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors flex items-center gap-1"
                        title="Inspect trace"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span className="text-[10px]">Inspect</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Trace Inspection Modal */}
      {selectedLog && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-2xl w-full p-6 shadow-2xl space-y-4 font-mono text-xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div>
                <h3 className="text-sm font-bold text-white">Trace Inspection</h3>
                <span className="text-[10px] text-slate-500">{selectedLog.trace_id}</span>
              </div>
              <button
                onClick={() => setSelectedLog(null)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                &times;
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-slate-300">
              <div>Provider: <span className="text-white">{selectedLog.provider_id}</span></div>
              <div>Model: <span className="text-white">{selectedLog.model}</span></div>
              <div>Status: <span className={selectedLog.status === 'success' ? 'text-emerald-400' : 'text-rose-400'}>{selectedLog.status_code} ({selectedLog.status})</span></div>
              <div>Latency: <span className="text-cyan-400">{selectedLog.latency_ms}ms</span></div>
              <div>Is Stream: <span className="text-white">{selectedLog.is_stream ? 'Yes' : 'No'}</span></div>
              <div>Is Hedged: <span className="text-white">{selectedLog.is_hedged ? 'Yes' : 'No'}</span></div>
            </div>

            {selectedLog.request_snippet && (
              <div>
                <span className="text-[10px] text-slate-500 uppercase block mb-1">Request Payload Snippet:</span>
                <pre className="bg-slate-950 p-2.5 rounded border border-slate-800 text-indigo-300 overflow-x-auto max-h-40">
                  {selectedLog.request_snippet}
                </pre>
              </div>
            )}

            {selectedLog.response_snippet && (
              <div>
                <span className="text-[10px] text-slate-500 uppercase block mb-1">Response Output / Error Snippet:</span>
                <pre className="bg-slate-950 p-2.5 rounded border border-slate-800 text-slate-300 overflow-x-auto max-h-40">
                  {selectedLog.response_snippet}
                </pre>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setSelectedLog(null)}
                className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded text-xs font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
