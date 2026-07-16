export const E2EE_VERSION: 1;
export const E2EE_MAX_CLOCK_SKEW_MS: number;

export type E2EEOperation = "stream" | "compact";
export type EncryptedEnvelope = Record<string, unknown> & {
  nonce: string;
  ciphertext: string;
  tag: string;
};

export function loadMasterKey(path: string): Buffer;
export function deriveKey(masterKey: Buffer, direction: "request" | "response"): Buffer;
export function requestAad(operation: E2EEOperation, id: string, timestamp: number): Buffer;
export function responseAad(operation: E2EEOperation, id: string, sequence: number): Buffer;
export function sealJson(key: Buffer, aad: Buffer, value: unknown): EncryptedEnvelope;
export function openJson(key: Buffer, aad: Buffer, envelope: Record<string, unknown>): unknown;
export function validateRequestEnvelope<T extends Record<string, unknown>>(envelope: T, now?: number): T;
