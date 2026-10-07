import type { ErrorClassificationType, ErrorClassificationRule, RateLimitHeadersConfig } from '../types/index.js';

export interface ClassifiedError {
  errorType: ErrorClassificationType;
  statusCode: number;
  message: string;
  retryAfterMs?: number;
  rawBody?: unknown;
}

// DECISION: Map errors with priority: explicitly defined spec rules first, then standard HTTP status codes and well-known AI provider error patterns as sensible fallbacks.
export function classifyError(
  statusCode: number,
  responseHeaders: Record<string, string | string[] | undefined>,
  responseBody: unknown,
  rules?: ErrorClassificationRule[],
  rateLimitHeadersConfig?: RateLimitHeadersConfig
): ClassifiedError {
  const bodyStr = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody || '');
  let message = `Upstream error with status ${statusCode}`;

  if (typeof responseBody === 'object' && responseBody !== null) {
    const body = responseBody as { error?: { message?: string }; message?: string; detail?: unknown };
    if (body.error?.message) {
      message = body.error.message;
    } else if (body.message) {
      message = body.message;
    } else if (body.detail) {
      message = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    }
  }

  // 1. Check custom spec rules first
  if (rules && rules.length > 0) {
    for (const rule of rules) {
      const matchStatus = rule.status_codes?.includes(statusCode);
      const matchPattern = rule.body_patterns?.some((pattern) => {
        try {
          const re = new RegExp(pattern, 'i');
          return re.test(bodyStr);
        } catch {
          return bodyStr.toLowerCase().includes(pattern.toLowerCase());
        }
      });

      if (matchStatus || matchPattern) {
        return {
          errorType: rule.error_type,
          statusCode,
          message,
          retryAfterMs: extractRetryAfter(responseHeaders, rateLimitHeadersConfig),
          rawBody: responseBody,
        };
      }
    }
  }

  // 2. Body-based pattern heuristics for quota and auth
  const lowerBody = bodyStr.toLowerCase();
  if (
    lowerBody.includes('insufficient_quota') ||
    lowerBody.includes('quota_exceeded') ||
    lowerBody.includes('credit_exhausted') ||
    lowerBody.includes('out of credits') ||
    lowerBody.includes('billing_not_active') ||
    lowerBody.includes('account_deactivated')
  ) {
    return {
      errorType: 'quota_exhausted',
      statusCode,
      message,
      rawBody: responseBody,
    };
  }

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    lowerBody.includes('invalid_api_key') ||
    lowerBody.includes('authentication_error') ||
    lowerBody.includes('unauthorized') ||
    lowerBody.includes('permission_denied')
  ) {
    return {
      errorType: 'auth_fail',
      statusCode,
      message,
      rawBody: responseBody,
    };
  }

  if (statusCode === 429 || lowerBody.includes('rate_limit') || lowerBody.includes('too many requests')) {
    return {
      errorType: 'rate_limit',
      statusCode,
      message,
      retryAfterMs: extractRetryAfter(responseHeaders, rateLimitHeadersConfig),
      rawBody: responseBody,
    };
  }

  if (statusCode >= 500 && statusCode <= 599) {
    return {
      errorType: 'retryable',
      statusCode,
      message,
      rawBody: responseBody,
    };
  }

  // Default 4xx errors are fatal (bad request, invalid parameter, model not found)
  return {
    errorType: 'fatal',
    statusCode,
    message,
    rawBody: responseBody,
  };
}

// DECISION: Extract Retry-After supporting both delta-seconds (e.g. "30") and HTTP-date formats (e.g. "Wed, 21 Oct 2026 07:28:00 GMT").
export function extractRetryAfter(
  headers: Record<string, string | string[] | undefined>,
  config?: RateLimitHeadersConfig
): number | undefined {
  const headerKey = (config?.retry_after || 'retry-after').toLowerCase();
  
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() === headerKey && val) {
      const headerVal = Array.isArray(val) ? val[0] : val;
      if (!headerVal) continue;

      const seconds = parseFloat(headerVal);
      if (!isNaN(seconds)) {
        return Math.max(1000, Math.round(seconds * 1000));
      }

      const dateMs = Date.parse(headerVal);
      if (!isNaN(dateMs)) {
        const diff = dateMs - Date.now();
        return diff > 0 ? diff : 1000;
      }
    }
  }

  // Check reset header if present
  if (config?.reset) {
    const resetKey = config.reset.toLowerCase();
    for (const [key, val] of Object.entries(headers)) {
      if (key.toLowerCase() === resetKey && val) {
        const headerVal = Array.isArray(val) ? val[0] : val;
        if (!headerVal) continue;
        const seconds = parseFloat(headerVal);
        if (!isNaN(seconds)) {
          return Math.max(1000, Math.round(seconds * 1000));
        }
      }
    }
  }

  return undefined;
}
