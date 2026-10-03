import type { ProviderSpec, OpenAIChatRequest, OpenAIChatResponse, OpenAIChatChunk } from '../types/index.js';
export interface PreparedUpstreamRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    stream: boolean;
}
export declare class TemplateMapper {
    static resolveModel(spec: ProviderSpec, requestedModel: string): string;
    static applyAuth(spec: ProviderSpec, key: string, url: string, headers: Record<string, string>, bodyObj?: any): {
        url: string;
        headers: Record<string, string>;
        bodyObj?: any;
    };
    static degradeToolsIfNeeded(req: OpenAIChatRequest): OpenAIChatRequest;
    static mapRequest(spec: ProviderSpec, req: OpenAIChatRequest, decryptedKey: string, modelOverride?: string): Promise<PreparedUpstreamRequest>;
    static mapResponse(spec: ProviderSpec, rawBody: any, modelName: string): Promise<OpenAIChatResponse>;
    static mapChunk(spec: ProviderSpec, rawChunkData: any, modelName: string): Promise<OpenAIChatChunk | null>;
}
