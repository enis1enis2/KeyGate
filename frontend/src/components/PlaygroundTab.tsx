import React, { useRef, useState } from 'react';
import {
  Brain,
  Send,
  Square,
  Trash2,
  Eye,
  EyeOff,
  KeyRound,
  CheckCircle2,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import type { ModelAlias } from '../types';

const PLAYGROUND_KEY_STORAGE = 'keygate.playground_key';

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  isError?: boolean;
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: { message?: string };
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface PlaygroundTabProps {
  aliases: ModelAlias[];
}

type StreamOutcome = 'completed' | 'aborted';

export const PlaygroundTab: React.FC<PlaygroundTabProps> = ({ aliases }) => {
  const [gatewayKey, setGatewayKey] = useState(() => localStorage.getItem(PLAYGROUND_KEY_STORAGE) ?? '');
  const [showKey, setShowKey] = useState(false);

  const chatPools = aliases.filter((alias) => alias.endpoint_kind === 'chat' && alias.is_active);
  const poolOptions = chatPools.length > 0 ? chatPools : aliases.filter((alias) => alias.is_active);
  const [pool, setPool] = useState(() => poolOptions[0]?.alias_name ?? '');
  const [systemPrompt, setSystemPrompt] = useState(
    'You are a helpful AI assistant answering via the KeyGate pool gateway.'
  );
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [stream, setStream] = useState(true);

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const [lastModel, setLastModel] = useState<string | null>(null);
  const [lastTrace, setLastTrace] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<Usage | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const updateAssistantContent = (index: number, content: string) => {
    setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, content } : m)));
  };

  const readSSE = async (
    res: Response,
    onDelta: (delta: string) => void,
    onUsage: (usage: Usage) => void
  ): Promise<StreamOutcome> => {
    if (!res.body) return 'completed';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          if (!payload) continue;
          let chunk: StreamChunk;
          try {
            chunk = JSON.parse(payload) as StreamChunk;
          } catch {
            continue;
          }
          if (chunk.error?.message) {
            throw new Error(chunk.error.message);
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) onDelta(delta);
          if (chunk.usage) onUsage(chunk.usage);
        }
      }
      return 'completed';
    } catch (err) {
      if (abortRef.current?.signal.aborted) return 'aborted';
      throw err;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // lock already released
      }
    }
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || sending) return;

    setBanner(null);
    setLastUsage(null);

    const userMessage: ChatMsg = { role: 'user', content: trimmed };
    setInput('');

    const userPrompt = systemPrompt.trim() ? systemPrompt.trim() : undefined;
    const apiMessages: Array<{ role: string; content: string }> = [];
    if (userPrompt) apiMessages.push({ role: 'system', content: userPrompt });
    for (const msg of messages) {
      if (msg.content.trim()) apiMessages.push({ role: msg.role, content: msg.content });
    }
    apiMessages.push({ role: userMessage.role, content: userMessage.content });

    const body: Record<string, unknown> = {
      model: pool,
      messages: apiMessages,
      temperature,
      stream,
    };
    if (maxTokens > 0) body.max_tokens = maxTokens;
    if (stream) body.stream_options = { include_usage: true };

    const abort = new AbortController();
    abortRef.current = abort;
    setSending(true);

    const assistantIndex = messages.length + 1;
    const startTime = Date.now();
    setMessages((prev) => [...prev, userMessage, { role: 'assistant', content: '' }]);

    const failAssistant = (message: string) => {
      setMessages((prev) =>
        prev.map((m, i) => (i === assistantIndex ? { ...m, content: `[error] ${message}`, isError: true } : m))
      );
      setBanner(message);
    };

    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayKey}` },
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      setLastProvider(res.headers.get('x-keygate-provider'));
      setLastModel(res.headers.get('x-keygate-model'));
      setLastTrace(res.headers.get('x-trace-id'));
      const responseProvider = res.headers.get('x-keygate-provider');

      if (!res.ok) {
        let message = `Upstream request failed with HTTP ${res.status}.`;
        const bodyData = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        if (bodyData?.error?.message) message = bodyData.error.message;
        failAssistant(message);
        return;
      }

      const contentType = res.headers.get('content-type') ?? '';
      const isStreaming = stream && contentType.includes('text/event-stream');

      if (!isStreaming) {
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
          usage?: Usage;
        };
        const content = data.choices?.[0]?.message?.content ?? '';
        updateAssistantContent(assistantIndex, content);
        if (data.usage) setLastUsage(data.usage);
        setBanner(
          content
            ? `Completed in ${Date.now() - startTime}ms${responseProvider ? ` via ${responseProvider}` : ''}.`
            : 'Upstream returned an empty completion.'
        );
        return;
      }

      let streamed = '';
      const outcome = await readSSE(
        res,
        (delta) => {
          streamed += delta;
          updateAssistantContent(assistantIndex, streamed);
        },
        (usage) => setLastUsage(usage)
      );

      updateAssistantContent(assistantIndex, streamed);
      setBanner(
        outcome === 'aborted'
          ? 'Stopped by you.'
          : streamed
            ? `Completed in ${Date.now() - startTime}ms${responseProvider ? ` via ${responseProvider}` : ''}.`
            : 'Upstream closed the stream without content.'
      );
    } catch (err) {
      if (abort.signal.aborted) {
        updateAssistantContent(assistantIndex, '');
        setBanner('Stopped by you.');
      } else {
        const message = err instanceof Error ? err.message : 'Request failed';
        failAssistant(message);
      }
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleClear = () => {
    abortRef.current?.abort();
    setMessages([]);
    setBanner(null);
    setLastProvider(null);
    setLastModel(null);
    setLastTrace(null);
    setLastUsage(null);
  };

  const messagesVisible = messages.filter((m) => m.content.length > 0 || (m.isError && m.role === 'assistant'));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-2 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">AI Playground</h1>
          <p className="text-sm text-slate-400">Chat against your AI pools through the gateway — add a gateway key and start talking</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={handleClear} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700 transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
            Clear Chat
          </button>
        </div>
      </div>

      {banner && (
        <div className={`flex items-start gap-2 px-4 py-3 rounded-lg text-sm border ${
          banner.startsWith('[error]') || banner.startsWith('Upstream request failed')
            ? 'bg-rose-500/10 text-rose-300 border-rose-500/30'
            : 'bg-slate-800/80 text-slate-300 border-slate-700/60'
        }`}>
          {banner.startsWith('[error]') || banner.startsWith('Upstream request failed') ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
          <span>{banner}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Settings panel */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-4">
            <h2 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-indigo-400" />
              Gateway Key
            </h2>
            <div className="flex items-center gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={gatewayKey}
                onChange={(e) => {
                  setGatewayKey(e.target.value);
                  localStorage.setItem(PLAYGROUND_KEY_STORAGE, e.target.value);
                }}
                placeholder="kg-…  (gateway token, not admin token)"
                autoComplete="off"
                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className="p-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
                title={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-4">
            <h2 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2">
              <Brain className="w-4 h-4 text-indigo-400" />
              Request Settings
            </h2>

            <label className="block">
              <span className="text-xs font-semibold text-slate-400">AI Pool (model alias)</span>
              <select
                value={pool}
                onChange={(e) => setPool(e.target.value)}
                className="w-full mt-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {poolOptions.length === 0 && <option value="">No active pools — create one in AI Pools</option>}
                {poolOptions.map((alias) => (
                  <option key={alias.id} value={alias.alias_name}>
                    {alias.alias_name} ({alias.endpoint_kind})
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-semibold text-slate-400">System prompt</span>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={3}
                className="w-full mt-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-semibold text-slate-400">Temperature</span>
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  className="w-full mt-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-slate-400">Max tokens</span>
                <input
                  type="number"
                  min={0}
                  step={64}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value))}
                  className="w-full mt-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </label>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={stream}
                onChange={(e) => setStream(e.target.checked)}
                className="w-4 h-4 rounded bg-slate-800 border-slate-700 accent-indigo-500"
              />
              <span className="text-sm text-slate-300">Stream the response</span>
            </label>
          </div>

          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-2 font-mono text-xs">
            <h2 className="text-sm font-bold text-slate-200 uppercase tracking-wider">Last response</h2>
            {lastUsage ? (
              <div className="flex items-center justify-between text-slate-400">
                <span className="text-slate-500">tokens</span>
                <span className="text-emerald-400">{lastUsage.prompt_tokens} in / {lastUsage.completion_tokens} out</span>
              </div>
            ) : (
              <div className="text-slate-600">No usage reported yet.</div>
            )}
            {lastProvider && (
              <div className="flex items-center justify-between text-slate-400">
                <span className="text-slate-500">provider</span>
                <span className="text-indigo-300">{lastProvider}</span>
              </div>
            )}
            {lastModel && (
              <div className="flex items-center justify-between text-slate-400">
                <span className="text-slate-500">model</span>
                <span className="text-slate-300">{lastModel}</span>
              </div>
            )}
            {lastTrace && (
              <div className="flex items-center justify-between text-slate-400">
                <span className="text-slate-500">trace</span>
                <span className="text-slate-500 truncate max-w-[10rem]" title={lastTrace}>{lastTrace.slice(0, 12)}…</span>
              </div>
            )}
          </div>
        </div>

        {/* Chat panel */}
        <div className="lg:col-span-3 flex flex-col bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden">
          <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-[420px] max-h-[60vh]">
            {messagesVisible.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 py-16">
                <Brain className="w-10 h-10 mb-3 text-slate-700" />
                <p className="text-sm">Ask something to warm up your pool.</p>
                <p className="text-xs mt-1 text-slate-600">If a provider rate-limits you or stalls, the gateway fails over and the full conversation travels with it.</p>
              </div>
            )}

            {messagesVisible.map((msg, i) => (
              <div key={`${msg.role}-${i}`} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] px-4 py-3 rounded-2xl text-sm whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white rounded-br-md'
                    : msg.isError
                      ? 'bg-rose-500/10 text-rose-200 border border-rose-500/30 rounded-bl-md'
                      : 'bg-slate-800 text-slate-200 rounded-bl-md'
                }`}>
                  {msg.content}
                  {sending && i === messagesVisible.length - 1 && msg.role === 'assistant' && (
                    <span className="inline-flex items-center gap-1.5 ml-2 text-slate-400">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-slate-800 p-4">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder={gatewayKey ? 'Type a message and press Enter to send…' : 'Add a gateway key on the left to start…'}
                rows={2}
                disabled={!gatewayKey}
                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              />
              {sending ? (
                <button
                  onClick={handleStop}
                  className="flex items-center gap-1.5 px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-100 text-sm font-semibold rounded-lg border border-slate-600 transition-colors"
                >
                  <Square className="w-4 h-4" />
                  Stop
                </button>
              ) : (
                <button
                  onClick={() => void handleSend()}
                  disabled={!gatewayKey || !input.trim()}
                  className="flex items-center gap-1.5 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  <Send className="w-4 h-4" />
                  Send
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-600 mt-2 font-mono">
              POST /v1/chat/completions · Bearer {gatewayKey ? '●●●●' + gatewayKey.slice(-4) : '(no key)'} · {stream ? 'SSE stream' : 'JSON'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PlaygroundTab;