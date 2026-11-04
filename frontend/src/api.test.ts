import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UnauthorizedError,
  clearAdminToken,
  errorMessage,
  fetchStats,
  getAdminToken,
  setAdminToken,
  subscribeToUnauthorized,
} from './api';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('admin token storage', () => {
  it('stores the token in sessionStorage', () => {
    setAdminToken('admin-token');

    expect(getAdminToken()).toBe('admin-token');
    expect(sessionStorage.getItem('keygate.admin_token')).toBe('admin-token');
  });

  it('clears the stored token', () => {
    setAdminToken('admin-token');
    clearAdminToken();

    expect(getAdminToken()).toBe('');
  });
});

describe('apiFetch', () => {
  beforeEach(() => {
    setAdminToken('admin-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the admin token as a bearer header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await fetchStats();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/dashboard/stats');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer admin-token');
  });

  it('clears the token, broadcasts and throws on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'Token expired' })));
    const onUnauthorized = vi.fn();
    const unsubscribe = subscribeToUnauthorized(onUnauthorized);

    await expect(fetchStats()).rejects.toBeInstanceOf(UnauthorizedError);

    expect(getAdminToken()).toBe('');
    expect(onUnauthorized).toHaveBeenCalledWith('Token expired');
    unsubscribe();
  });

  it('defaults the broadcast message when the 401 body is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const onUnauthorized = vi.fn();
    const unsubscribe = subscribeToUnauthorized(onUnauthorized);

    await expect(fetchStats()).rejects.toThrow('Unauthorized');
    expect(onUnauthorized).toHaveBeenCalledWith('Unauthorized');
    unsubscribe();
  });
});

describe('errorMessage', () => {
  it('unwraps Error, string and unknown values', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(undefined)).toBe('Something went wrong');
  });
});
