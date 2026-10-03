import type { ProviderSpec } from '../types/index.js';
export interface DraftProviderResult {
    spec: ProviderSpec;
    specYaml: string;
    detectedKey?: string;
    warnings: string[];
}
export declare function parseCurlAndDraftSpec(curlCmd: string, sampleResponseJson?: string): DraftProviderResult;
