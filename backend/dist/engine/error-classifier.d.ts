import type { ErrorClassificationType, ErrorClassificationRule, RateLimitHeadersConfig } from '../types/index.js';
export interface ClassifiedError {
    errorType: ErrorClassificationType;
    statusCode: number;
    message: string;
    retryAfterMs?: number;
    rawBody?: any;
}
export declare function classifyError(statusCode: number, responseHeaders: Record<string, string | string[] | undefined>, responseBody: any, rules?: ErrorClassificationRule[], rateLimitHeadersConfig?: RateLimitHeadersConfig): ClassifiedError;
export declare function extractRetryAfter(headers: Record<string, string | string[] | undefined>, config?: RateLimitHeadersConfig): number | undefined;
