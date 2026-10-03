import type { 
  Provider, 
  ApiKeyItem, 
  ModelAlias, 
  GatewayKey, 
  RequestLog, 
  DashboardStats 
} from './types';

const API_BASE = '';

export async function fetchStats(): Promise<DashboardStats> {
  const res = await fetch(`${API_BASE}/api/dashboard/stats`);
  if (!res.ok) throw new Error('Failed to fetch stats');
  return res.json();
}

export async function fetchProviders(): Promise<Provider[]> {
  const res = await fetch(`${API_BASE}/api/providers`);
  if (!res.ok) throw new Error('Failed to fetch providers');
  return res.json();
}

export async function saveProvider(specYaml: string): Promise<{ success: boolean; id: string }> {
  const res = await fetch(`${API_BASE}/api/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec_yaml: specYaml }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to save provider' }));
    throw new Error(err.error || 'Failed to save provider');
  }
  return res.json();
}

export async function deleteProvider(id: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/providers/${id}`, { method: 'DELETE' });
  const data = await res.json();
  return data.success;
}

export async function draftSpecFromCurl(curlCommand: string, sampleResponse?: string): Promise<{ specYaml: string; detectedKey?: string; warnings: string[] }> {
  const res = await fetch(`${API_BASE}/api/providers/wizard/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ curl_command: curlCommand, sample_response: sampleResponse }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to draft spec' }));
    throw new Error(err.error || 'Failed to draft spec');
  }
  return res.json();
}

export async function testProviderSpec(specYaml: string, testKey: string, prompt?: string, model?: string) {
  const res = await fetch(`${API_BASE}/api/providers/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec_yaml: specYaml, test_key: testKey, prompt, model }),
  });
  return res.json();
}

export async function fetchKeys(): Promise<ApiKeyItem[]> {
  const res = await fetch(`${API_BASE}/api/keys`);
  if (!res.ok) throw new Error('Failed to fetch keys');
  return res.json();
}

export async function addKey(data: { provider_id: string; key_name: string; api_key: string; rpm_cap?: number; tpm_cap?: number; daily_budget_cap?: number }) {
  const res = await fetch(`${API_BASE}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to add key' }));
    throw new Error(err.error || 'Failed to add key');
  }
  return res.json();
}

export async function updateKey(id: string, data: { is_active?: boolean; rpm_cap?: number; tpm_cap?: number; daily_budget_cap?: number; reset_circuit?: boolean }) {
  const res = await fetch(`${API_BASE}/api/keys/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function deleteKey(id: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/keys/${id}`, { method: 'DELETE' });
  const data = await res.json();
  return data.success;
}

export async function fetchAliases(): Promise<ModelAlias[]> {
  const res = await fetch(`${API_BASE}/api/aliases`);
  if (!res.ok) throw new Error('Failed to fetch aliases');
  return res.json();
}

export async function saveAlias(alias: Partial<ModelAlias>): Promise<{ success: boolean; id: string }> {
  const res = await fetch(`${API_BASE}/api/aliases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(alias),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to save alias' }));
    throw new Error(err.error || 'Failed to save alias');
  }
  return res.json();
}

export async function deleteAlias(id: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/aliases/${id}`, { method: 'DELETE' });
  const data = await res.json();
  return data.success;
}

export async function fetchGatewayKeys(): Promise<GatewayKey[]> {
  const res = await fetch(`${API_BASE}/api/gateway-keys`);
  if (!res.ok) throw new Error('Failed to fetch gateway keys');
  return res.json();
}

export async function createGatewayKey(data: { name: string; rpm_limit?: number; tpm_limit?: number; allowed_aliases?: string[]; expires_in_days?: number }): Promise<{ token: string; id: string; name: string }> {
  const res = await fetch(`${API_BASE}/api/gateway-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to generate token' }));
    throw new Error(err.error || 'Failed to generate token');
  }
  return res.json();
}

export async function revokeGatewayKey(id: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/gateway-keys/${id}/revoke`, { method: 'POST' });
  const data = await res.json();
  return data.success;
}

export async function deleteGatewayKey(id: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/gateway-keys/${id}`, { method: 'DELETE' });
  const data = await res.json();
  return data.success;
}

export async function fetchLogs(filters?: { status?: string; provider_id?: string; model?: string; limit?: number }): Promise<RequestLog[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.provider_id) params.set('provider_id', filters.provider_id);
  if (filters?.model) params.set('model', filters.model);
  if (filters?.limit) params.set('limit', filters.limit.toString());

  const res = await fetch(`${API_BASE}/api/logs?${params.toString()}`);
  if (!res.ok) throw new Error('Failed to fetch logs');
  return res.json();
}
