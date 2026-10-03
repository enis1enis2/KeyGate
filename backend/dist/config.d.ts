export declare const CONFIG: {
    port: number;
    host: string;
    masterKey: NonSharedBuffer;
    dbPath: string;
    requireAuth: boolean;
    logLevel: string;
    metricsRetentionDays: number;
    circuitBreaker: {
        failureThreshold: number;
        successRateThreshold: number;
        baseCooldownMs: number;
        maxCooldownMs: number;
        quotaCooldownMs: number;
    };
    defaultTimeoutMs: number;
};
