import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { FastifyInstance } from 'fastify';

// Isolated file so MAX_UPLOAD_BYTES is applied before src/config.ts loads.
// Kept small to make the pre-auth body-buffering check cheap.
process.env.MAX_UPLOAD_BYTES = '4096';

// Security audit: gateway authentication must happen before any request body is buffered.
// A multipart upload larger than the size limit used to be fully processed (and partially
// buffered) before the bearer token was checked, letting unauthenticated callers drive
// up to MAX_UPLOAD_BYTES × files of gateway memory per request.

describe('pre-authentication body handling', () => {
  let app: FastifyInstance;
  let appPort: number;

  beforeAll(async () => {
    const { buildServer } = await import('../src/server.js');
    const { getDb } = await import('../src/db/index.js');
    getDb();
    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    appPort = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const multipartBody = (fileSize: number): { body: string; contentType: string } => {
    const boundary = '----keygate-audit';
    const parts = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="model"',
      '',
      'some-pool',
      `--${boundary}`,
      'Content-Disposition: form-data; name="image"; filename="big.bin"',
      'Content-Type: application/octet-stream',
      '',
      'A'.repeat(fileSize),
      `--${boundary}--`,
      '',
    ];
    return { body: parts.join('\r\n'), contentType: `multipart/form-data; boundary=${boundary}` };
  };

  it('answers an oversized multipart upload with 401 for an invalid token, never 413', async () => {
    const { body, contentType } = multipartBody(8192);
    const res = await fetch(`http://127.0.0.1:${appPort}/v1/images/edits`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Authorization: 'Bearer invalid-token-xyz' },
      body,
    });
    expect(res.status).toBe(401);
    const parsed = (await res.json()) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe('invalid_api_key');
  });

  it('answers an unauthenticated multipart upload with 401 before touching the body', async () => {
    const { body, contentType } = multipartBody(128);
    const res = await fetch(`http://127.0.0.1:${appPort}/v1/images/edits`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('answers unauthenticated JSON bodies with the OpenAI key error', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bogus' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    expect(res.status).toBe(401);
    const parsed = (await res.json()) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe('invalid_api_key');
  });
});
