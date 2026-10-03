export declare function encryptSecret(plainText: string): {
    encrypted: string;
    iv: string;
    tag: string;
};
export declare function decryptSecret(encryptedHex: string, ivHex: string, tagHex: string): string;
export declare function maskKey(key: string): {
    prefix: string;
    suffix: string;
    masked: string;
};
export declare function hashToken(token: string): string;
export declare function generateGatewayToken(prefix?: string): {
    rawToken: string;
    tokenHash: string;
    tokenPrefix: string;
    tokenSuffix: string;
};
