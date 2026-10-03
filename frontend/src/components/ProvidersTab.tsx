import React, { useState } from 'react';
import { 
  Server, 
  Wand2, 
  Play, 
  Trash2, 
  Check, 
  Copy, 
  AlertCircle, 
  CheckCircle,
  FileCode,
  ArrowRight
} from 'lucide-react';
import type { Provider } from '../types';
import { saveProvider, deleteProvider, draftSpecFromCurl, testProviderSpec } from '../api';

interface ProvidersTabProps {
  providers: Provider[];
  onRefresh: () => void;
}

export const ProvidersTab: React.FC<ProvidersTabProps> = ({ providers, onRefresh }) => {
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(providers[0] || null);
  const [specYaml, setSpecYaml] = useState<string>(providers[0]?.spec_yaml || '');
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Wizard state
  const [showWizard, setShowWizard] = useState(false);
  const [curlCommand, setCurlCommand] = useState('');
  const [sampleResponse, setSampleResponse] = useState('');
  const [wizardWarning, setWizardWarning] = useState<string[]>([]);
  const [detectedKey, setDetectedKey] = useState<string | null>(null);

  // Live Test state
  const [testKey, setTestKey] = useState('');
  const [testModel, setTestModel] = useState('');
  const [testPrompt, setTestPrompt] = useState('Write a 1-sentence haiku about speed.');
  const [isRunningTest, setIsRunningTest] = useState(false);
  const [testResult, setTestResult] = useState<any | null>(null);

  const handleSelect = (p: Provider) => {
    setSelectedProvider(p);
    setSpecYaml(p.spec_yaml);
    setTestResult(null);
    setSaveStatus(null);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveStatus(null);
    try {
      await saveProvider(specYaml);
      setSaveStatus('Spec saved successfully!');
      onRefresh();
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err: any) {
      setSaveStatus(`Error: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this provider spec?')) return;
    await deleteProvider(id);
    onRefresh();
    if (selectedProvider?.id === id) {
      setSelectedProvider(null);
      setSpecYaml('');
    }
  };

  const handleDraftFromCurl = async () => {
    if (!curlCommand.trim()) return;
    try {
      const res = await draftSpecFromCurl(curlCommand, sampleResponse);
      setSpecYaml(res.specYaml);
      setWizardWarning(res.warnings || []);
      if (res.detectedKey) {
        setDetectedKey(res.detectedKey);
        setTestKey(res.detectedKey);
      }
      setShowWizard(false);
      setSaveStatus('Drafted spec from cURL! You can test or save it below.');
    } catch (err: any) {
      alert(`Wizard error: ${err.message}`);
    }
  };

  const handleRunTest = async () => {
    if (!testKey.trim()) {
      alert('Please enter a test API key to send the request.');
      return;
    }
    setIsRunningTest(true);
    setTestResult(null);
    try {
      const res = await testProviderSpec(specYaml, testKey, testPrompt, testModel || undefined);
      setTestResult(res);
    } catch (err: any) {
      setTestResult({ success: false, error: err.message });
    } finally {
      setIsRunningTest(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header and Wizard Toggle */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-2 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Declarative Providers & Wizard</h1>
          <p className="text-sm text-slate-400">Providers are pure YAML data specs: endpoints, auth templates, and JSONata transforms</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowWizard(!showWizard)}
            className="flex items-center gap-2 px-3.5 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white text-xs font-semibold rounded-lg shadow-md shadow-indigo-500/20 transition-all"
          >
            <Wand2 className="w-3.5 h-3.5" />
            {showWizard ? 'Close Wizard' : 'Add Provider Wizard'}
          </button>
        </div>
      </div>

      {/* Add Provider Wizard Modal / Card */}
      {showWizard && (
        <div className="bg-slate-900 border border-indigo-500/30 rounded-xl p-5 shadow-xl space-y-4">
          <div className="flex items-center gap-2 text-indigo-400">
            <Wand2 className="w-5 h-5" />
            <h2 className="text-base font-bold text-white">cURL Spec Generator Wizard</h2>
          </div>
          <p className="text-xs text-slate-400">
            Paste any cURL request example (from Cohere, Anthropic, Mistral, Groq, or proprietary API docs) and an optional sample response JSON. KeyGate will infer the authentication, endpoint, and declarative mapping template!
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                cURL Command Example:
              </label>
              <textarea
                value={curlCommand}
                onChange={(e) => setCurlCommand(e.target.value)}
                placeholder={`curl -X POST https://api.anthropic.com/v1/messages \\\n  -H "x-api-key: $ANTHROPIC_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "claude-3-5-sonnet", "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 100}'`}
                rows={6}
                className="w-full bg-slate-950 text-slate-200 border border-slate-800 rounded-lg p-3 text-xs font-mono focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                Sample Response JSON (Optional, helps auto-map output):
              </label>
              <textarea
                value={sampleResponse}
                onChange={(e) => setSampleResponse(e.target.value)}
                placeholder={`{\n  "id": "msg_01",\n  "content": [{"type": "text", "text": "Hello! How can I help you today?"}],\n  "usage": {"input_tokens": 10, "output_tokens": 15}\n}`}
                rows={6}
                className="w-full bg-slate-950 text-slate-200 border border-slate-800 rounded-lg p-3 text-xs font-mono focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={() => setShowWizard(false)}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleDraftFromCurl}
              disabled={!curlCommand.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors"
            >
              <Wand2 className="w-3.5 h-3.5" />
              Generate Draft Spec
            </button>
          </div>
        </div>
      )}

      {/* Main Grid: Left Provider Selector, Right Editor + Live Test */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Provider List */}
        <div className="lg:col-span-4 space-y-3">
          <div className="flex items-center justify-between pb-1">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Installed Providers</h2>
            <button
              onClick={() => {
                setSelectedProvider(null);
                setSpecYaml(`id: new-provider\nname: New Provider\npreset: openai-compatible\nbase_url: https://api.example.com/v1\nendpoint_paths:\n  chat: /chat/completions\nhttp_method: POST\nauth:\n  type: header\n  name: Authorization\n  template: Bearer {{key}}\nstreaming:\n  type: sse\n`);
                setTestResult(null);
              }}
              className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold"
            >
              + Create New
            </button>
          </div>

          <div className="space-y-2">
            {providers.map((p) => {
              const isSelected = selectedProvider?.id === p.id;
              return (
                <div
                  key={p.id}
                  onClick={() => handleSelect(p)}
                  className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-slate-900 border-indigo-500/80 shadow-md shadow-indigo-500/10'
                      : 'bg-slate-900/60 border-slate-800/80 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-sm font-semibold text-white flex items-center gap-2">
                        {p.name}
                        {p.preset === 'openai-compatible' && (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            Fastpath
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400 font-mono mt-0.5">{p.id}</div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(p.id);
                      }}
                      className="text-slate-500 hover:text-rose-400 p-1 rounded transition-colors"
                      title="Delete Provider"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {p.description && (
                    <p className="text-xs text-slate-400 mt-2 line-clamp-1">{p.description}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Spec YAML Editor & Live Test */}
        <div className="lg:col-span-8 space-y-4">
          <div className="bg-slate-900/60 rounded-xl border border-slate-800/80 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileCode className="w-4 h-4 text-indigo-400" />
                <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                  Provider YAML Spec Editor
                </h2>
              </div>
              <div className="flex items-center gap-2">
                {saveStatus && (
                  <span className={`text-xs ${saveStatus.startsWith('Error') ? 'text-rose-400' : 'text-emerald-400'} font-medium`}>
                    {saveStatus}
                  </span>
                )}
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
                >
                  <Check className="w-3.5 h-3.5" />
                  {isSaving ? 'Saving...' : 'Save Spec'}
                </button>
              </div>
            </div>

            <textarea
              value={specYaml}
              onChange={(e) => setSpecYaml(e.target.value)}
              rows={16}
              className="w-full bg-slate-950 text-slate-200 border border-slate-800 rounded-lg p-3 text-xs font-mono leading-relaxed focus:border-indigo-500 focus:outline-none"
              spellCheck={false}
            />

            {/* Live Test Panel */}
            <div className="border-t border-slate-800 pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-300 uppercase tracking-wider">
                  <Play className="w-3.5 h-3.5 text-emerald-400" />
                  Live Spec Tester
                </div>
                <span className="text-[11px] text-slate-500">
                  Tests request mapping, live upstream call, and OpenAI response translation
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Test Upstream API Key:</label>
                  <input
                    type="password"
                    value={testKey}
                    onChange={(e) => setTestKey(e.target.value)}
                    placeholder="Paste temporary test key"
                    className="w-full bg-slate-950 text-white border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-mono focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Model (optional override):</label>
                  <input
                    type="text"
                    value={testModel}
                    onChange={(e) => setTestModel(e.target.value)}
                    placeholder="e.g. llama-3.3-70b-versatile"
                    className="w-full bg-slate-950 text-white border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-mono focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    onClick={handleRunTest}
                    disabled={isRunningTest || !testKey.trim()}
                    className="w-full flex items-center justify-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
                  >
                    <Play className={`w-3.5 h-3.5 ${isRunningTest ? 'animate-spin' : ''}`} />
                    {isRunningTest ? 'Sending Test...' : 'Test Spec Output'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Test User Prompt:</label>
                <input
                  type="text"
                  value={testPrompt}
                  onChange={(e) => setTestPrompt(e.target.value)}
                  className="w-full bg-slate-950 text-white border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs focus:border-indigo-500 focus:outline-none"
                />
              </div>

              {/* Live Test Results View */}
              {testResult && (
                <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-3 font-mono text-xs">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <div className="flex items-center gap-2">
                      {testResult.success ? (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-semibold">
                          HTTP {testResult.statusCode || 200} OK
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 text-xs font-semibold">
                          Error {testResult.statusCode || 'Failed'}
                        </span>
                      )}
                      {testResult.latencyMs && (
                        <span className="text-slate-400">Latency: {testResult.latencyMs}ms</span>
                      )}
                    </div>
                  </div>

                  {testResult.preparedRequest && (
                    <div>
                      <span className="text-[11px] text-slate-500 uppercase block mb-1">1. Prepared Upstream Request:</span>
                      <pre className="bg-slate-900 p-2.5 rounded text-indigo-300 text-[11px] overflow-x-auto max-h-40">
                        {JSON.stringify(testResult.preparedRequest, null, 2)}
                      </pre>
                    </div>
                  )}

                  {testResult.rawResponse && (
                    <div>
                      <span className="text-[11px] text-slate-500 uppercase block mb-1">2. Raw Upstream Response:</span>
                      <pre className="bg-slate-900 p-2.5 rounded text-slate-300 text-[11px] overflow-x-auto max-h-40">
                        {typeof testResult.rawResponse === 'object' ? JSON.stringify(testResult.rawResponse, null, 2) : testResult.rawResponse}
                      </pre>
                    </div>
                  )}

                  {testResult.mappedResponse && (
                    <div>
                      <span className="text-[11px] text-slate-500 uppercase block mb-1 text-emerald-400 font-bold">
                        3. Mapped OpenAI Chat Completion Output:
                      </span>
                      <pre className="bg-slate-900 p-2.5 rounded text-emerald-300 text-[11px] overflow-x-auto max-h-48 border border-emerald-500/20">
                        {JSON.stringify(testResult.mappedResponse, null, 2)}
                      </pre>
                    </div>
                  )}

                  {testResult.mappingError && (
                    <div className="text-rose-400 text-xs bg-rose-950/20 p-2 rounded border border-rose-800">
                      Response Mapping Error: {testResult.mappingError}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
