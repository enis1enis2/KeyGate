import type { ClassifiedError } from './engine/error-classifier.js';

// DECISION: Upstream failures are thrown as plain structured objects (not Error subclasses),
// so error handling goes through a single narrowing helper instead of `any` casts.
export interface ErrorInfo {
  message: string;
  statusCode?: number;
  latencyMs?: number;
  classified?: ClassifiedError;
}

export function toErrorInfo(err: unknown): ErrorInfo {
  if (typeof err === 'string') {
    return { message: err };
  }

  if (typeof err === 'object' && err !== null) {
    const e = err as {
      message?: unknown;
      statusCode?: unknown;
      latencyMs?: unknown;
      classified?: unknown;
    };
    const classified =
      typeof e.classified === 'object' && e.classified !== null && 'errorType' in e.classified
        ? (e.classified as ClassifiedError)
        : undefined;

    return {
      message: typeof e.message === 'string' ? e.message : '',
      statusCode: typeof e.statusCode === 'number' ? e.statusCode : undefined,
      latencyMs: typeof e.latencyMs === 'number' ? e.latencyMs : undefined,
      classified,
    };
  }

  return { message: '' };
}

export function errorMessage(err: unknown): string {
  return toErrorInfo(err).message || 'Unknown error';
}

// DECISION: Every surface (chat, proxy passthrough, legacy endpoints) answers with the same
// OpenAI error envelope, so the classification → OpenAI error type mapping lives in one place.
const OPENAI_ERROR_TYPE: Record<string, string> = {
  rate_limit: 'rate_limit_error',
  auth_fail: 'authentication_error',
  quota_exhausted: 'insufficient_quota',
  timeout: 'api_error',
  retryable: 'api_error',
  fatal: 'api_error',
};

export function openaiErrorType(classifiedType?: string): string {
  return (classifiedType && OPENAI_ERROR_TYPE[classifiedType]) || 'api_error';
}

export interface OpenAIErrorEnvelope {
  error: { message: string; type: string; code: string };
}

export function toOpenAIError(info: ErrorInfo): OpenAIErrorEnvelope {
  const classifiedType = info.classified?.errorType;
  return {
    error: {
      message: info.classified?.message || info.message || 'Internal gateway error',
      type: openaiErrorType(classifiedType),
      code: classifiedType || 'internal_error',
    },
  };
}
