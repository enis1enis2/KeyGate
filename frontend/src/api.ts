import type { 
  Provider, 
  ApiKeyItem, 
  ModelAlias, 
  GatewayKey, 
  RequestLog, 
  DashboardStats,
  ProviderTestResult,
  ModelPricing
} from './types';

const API_BASE = '';
const ADMIN_TOKEN_STORAGE_KEY = 'keygate.admin_token';

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Something went wrong';
}

// DECISION: Broadcast auth failures on the window as well as throwing, so a swallowed
// promise rejection (e.g. Promise.all fallbacks) can never leave the console unlocked.
const UNAUTHORIZED_EVENT = 'keygate:unauthorized';

function broadcastUnauthorized(message: string): void {
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: { message } }));
}

export function subscribeToUnauthorized(handler: (message: string) => void): () => void {
  const listener = (event: Event) => {
    handler((event as CustomEvent<{ message: string }>).detail.message);
  };
  window.addEventListener(UNAUTHORIZED_EVENT, listener);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, listener);
}

export function getAdminToken(): string {
  return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? '';
}

export function setAdminToken(token: string): void {
  localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
}

export function clearAdminToken(): void {
  localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getAdminToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (res.status === 401) {
    clearAdminToken();
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const message = body?.error || 'Unauthorized';
    broadcastUnauthorized(message);
    throw new UnauthorizedError(message);
  }

  return res;
}

function jsonBody(data: unknown): RequestInit {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

export async function fetchStats(): Promise<DashboardStats> {
  const res = await apiFetch('/api/dashboard/stats');
  if (!res.ok) throw new Error('Failed to fetch stats');
  return res.json();
}

export async function fetchProviders(): Promise<Provider[]> {
  const res = await apiFetch('/api/providers');
  if (!res.ok) throw new Error('Failed to fetch providers');
  return res.json();
}

export async function saveProvider(specYaml: string): Promise<{ success: boolean; id: string }> {
  const res = await apiFetch('/api/providers', {
    method: 'POST',
    ...jsonBody({ spec_yaml: specYaml }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to save provider' }));
    throw new Error(err.error || 'Failed to save provider');
  }
  return res.json();
}

export async function deleteProvider(id: string): Promise<boolean> {
  const res = await apiFetch(`/api/providers/${id}`, { method: 'DELETE' });
  const data = await res.json();
  return data.success;
}

export async function draftSpecFromCurl(curlCommand: string, sampleResponse?: string): Promise<{ specYaml: string; detectedKey?: string; warnings: string[] }> {
  const res = await apiFetch('/api/providers/wizard/draft', {
    method: 'POST',
    ...jsonBody({ curl_command: curlCommand, sample_response: sampleResponse }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to draft spec' }));
    throw new Error(err.error || 'Failed to draft spec');
  }
  return res.json();
}

export async function testProviderSpec(specYaml: string, testKey: string, prompt?: string, model?: string): Promise<ProviderTestResult> {
  const res = await apiFetch('/api/providers/test', {
    method: 'POST',
    ...jsonBody({ spec_yaml: specYaml, test_key: testKey, prompt, model }),
  });
  return res.json();
}

export async function fetchKeys(): Promise<ApiKeyItem[]> {
  const res = await apiFetch('/api/keys');
  if (!res.ok) throw new Error('Failed to fetch keys');
  return res.json();
}

export async function addKey(data: { provider_id: string; key_name: string; api_key: string; rpm_cap?: number; tpm_cap?: number; daily_budget_cap?: number }) {
  const res = await apiFetch('/api/keys', {
    method: 'POST',
    ...jsonBody(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to add key' }));
    throw new Error(err.error || 'Failed to add key');
  }
  return res.json();
}

export async function updateKey(id: string, data: { is_active?: boolean; rpm_cap?: number; tpm_cap?: number; daily_budget_cap?: number; reset_circuit?: boolean }) {
  const res = await apiFetch(`/api/keys/${id}`, {
    method: 'PUT',
    ...jsonBody(data),
  });
  return res.json();
}

export async function deleteKey(id: string): Promise<boolean> {
  const res = await apiFetch(`/api/keys/${id}`, { method: 'DELETE' });
  const data = await res.json();
  return data.success;
}

export async function fetchAliases(): Promise<ModelAlias[]> {
  const res = await apiFetch('/api/aliases');
  if (!res.ok) throw new Error('Failed to fetch aliases');
  return res.json();
}

export async function saveAlias(alias: Partial<ModelAlias>): Promise<{ success: boolean; id: string }> {
  const res = await apiFetch('/api/aliases', {
    method: 'POST',
    ...jsonBody(alias),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to save alias' }));
    throw new Error(err.error || 'Failed to save alias');
  }
  return res.json();
}

export async function deleteAlias(id: string): Promise<boolean> {
  const res = await apiFetch(`/api/aliases/${id}`, { method: 'DELETE' });
  const data = await res.json();
  return data.success;
}

export async function fetchGatewayKeys(): Promise<GatewayKey[]> {
  const res = await apiFetch('/api/gateway-keys');
  if (!res.ok) throw new Error('Failed to fetch gateway keys');
  return res.json();
}

export async function createGatewayKey(data: { name: string; rpm_limit?: number; tpm_limit?: number; allowed_aliases?: string[]; expires_in_days?: number }): Promise<{ token: string; id: string; name: string }> {
  const res = await apiFetch('/api/gateway-keys', {
    method: 'POST',
    ...jsonBody(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to generate token' }));
    throw new Error(err.error || 'Failed to generate token');
  }
  return res.json();
}

export async function revokeGatewayKey(id: string): Promise<boolean> {
  const res = await apiFetch(`/api/gateway-keys/${id}/revoke`, { method: 'POST' });
  const data = await res.json();
  return data.success;
}

export async function deleteGatewayKey(id: string): Promise<boolean> {
  const res = await apiFetch(`/api/gateway-keys/${id}`, { method: 'DELETE' });
  const data = await res.json();
  return data.success;
}

export async function fetchLogs(filters?: { status?: string; provider_id?: string; model?: string; endpoint?: string; limit?: number }): Promise<RequestLog[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.provider_id) params.set('provider_id', filters.provider_id);
  if (filters?.model) params.set('model', filters.model);
  if (filters?.endpoint) params.set('endpoint', filters.endpoint);
  if (filters?.limit) params.set('limit', filters.limit.toString());

  const res = await apiFetch(`/api/logs?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to fetch logs');
  return res.json();
}

export async function fetchPricing(): Promise<ModelPricing[]> {
  const res = await apiFetch('/api/pricing');
  if (!res.ok) throw new Error('Failed to fetch pricing');
  return res.json();
}

export async function savePricing(row: Partial<ModelPricing>): Promise<{ success: boolean; id: string }> {
  const res = await apiFetch('/api/pricing', {
    method: 'POST',
    ...jsonBody(row),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to save pricing' }));
    throw new Error(err.error || 'Failed to save pricing');
  }
  return res.json();
}

export async function deletePricing(id: string): Promise<boolean> {
  const res = await apiFetch(`/api/pricing/${id}`, { method: 'DELETE' });
  const data = await res.json();
  return data.success;
}
