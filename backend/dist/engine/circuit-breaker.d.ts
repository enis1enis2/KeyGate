import type { KeyHealthStats, ErrorClassificationType } from '../types/index.js';
export declare class CircuitBreakerManager {
    private static instance;
    private callHistory;
    private minuteTokens;
    private halfOpenProbingKeys;
    private constructor();
    static getInstance(): CircuitBreakerManager;
    private getHistory;
    recordCallResult(keyId: string, success: boolean, latencyMs: number, promptTokens?: number, completionTokens?: number, errorType?: ErrorClassificationType, errorMessage?: string, retryAfterMs?: number): void;
    isKeyAvailable(keyId: string): {
        available: boolean;
        reason?: string;
        isProbe?: boolean;
    };
    getKeyStats(keyId: string): KeyHealthStats;
    resetCircuit(keyId: string): void;
}
