import type { ProviderSpec, ApiKeyRecord, TargetConfig, ModelAliasRecord, OpenAIChatRequest, OpenAIChatResponse } from '../types/index.js';
export interface RouteAttemptResult {
    response?: OpenAIChatResponse;
    streamResponse?: Response;
    providerId: string;
    keyId: string;
    model: string;
    latencyMs: number;
    statusCode: number;
    promptTokens: number;
    completionTokens: number;
    isStream: boolean;
    isHedged: boolean;
    spec: ProviderSpec;
}
export declare class SmartRouter {
    private static instance;
    private roundRobinIndices;
    private constructor();
    static getInstance(): SmartRouter;
    getProviderSpec(providerId: string): ProviderSpec | null;
    sortTargets(alias: ModelAliasRecord, targets: TargetConfig[]): TargetConfig[];
    getCandidateKeys(providerId: string): {
        key: ApiKeyRecord;
        isProbe?: boolean;
    }[];
    private executeAttempt;
    routeChatCompletion(aliasName: string, req: OpenAIChatRequest, traceId?: string, gatewayKeyId?: string): Promise<RouteAttemptResult>;
    private executeHedgedAttempt;
}
