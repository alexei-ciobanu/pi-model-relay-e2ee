import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

export const E2EE_VERSION = 2;
export const E2EE_MAX_CLOCK_SKEW_MS = 60_000;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PROTOCOL_DOMAIN = "pi-model-relay-e2ee/v2";
const HKDF_SALT = Buffer.from(PROTOCOL_DOMAIN, "utf8");
const OPERATIONS = new Set(["models", "stream", "compact"]);

function decodeBase64Url(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return Buffer.from(value, "base64url");
}

export function loadMasterKey(path) {
  const key = readFileSync(path);
  if (key.length !== KEY_BYTES) {
    throw new Error(`E2EE key must contain exactly ${KEY_BYTES} raw bytes: ${path}`);
  }
  return key;
}

export function deriveKey(masterKey, direction) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== KEY_BYTES) {
    throw new Error(`E2EE master key must be ${KEY_BYTES} bytes`);
  }
  if (direction !== "request" && direction !== "response") {
    throw new Error("Invalid E2EE key direction");
  }
  return Buffer.from(hkdfSync("sha256", masterKey, HKDF_SALT, Buffer.from(direction, "utf8"), KEY_BYTES));
}

function validateOperation(operation) {
  if (!OPERATIONS.has(operation)) throw new Error("Invalid E2EE operation");
  return operation;
}

export function requestAad(operation, id, timestamp) {
  return Buffer.from(`${PROTOCOL_DOMAIN}/${validateOperation(operation)}/request/${id}/${timestamp}`, "utf8");
}

export function responseAad(operation, id, sequence) {
  return Buffer.from(`${PROTOCOL_DOMAIN}/${validateOperation(operation)}/response/${id}/${sequence}`, "utf8");
}

export function sealJson(key, aad, value) {
  const nonce = randomBytes(NONCE_BYTES);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function openJson(key, aad, envelope) {
  if (!envelope || typeof envelope !== "object") throw new Error("Invalid encrypted envelope");
  const nonce = decodeBase64Url(envelope.nonce, "nonce");
  const ciphertext = decodeBase64Url(envelope.ciphertext, "ciphertext");
  const tag = decodeBase64Url(envelope.tag, "authentication tag");
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new Error("Invalid encrypted envelope");

  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad, { plaintextLength: ciphertext.length });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function validateRequestEnvelope(envelope, now = Date.now()) {
  if (!envelope || typeof envelope !== "object" || envelope.v !== E2EE_VERSION) {
    throw new Error("Unsupported encrypted protocol version");
  }
  if (typeof envelope.id !== "string" || !/^[0-9a-f-]{36}$/i.test(envelope.id)) {
    throw new Error("Invalid request id");
  }
  if (!Number.isSafeInteger(envelope.timestamp) || Math.abs(now - envelope.timestamp) > E2EE_MAX_CLOCK_SKEW_MS) {
    throw new Error("Encrypted request timestamp is outside the allowed window");
  }
  return envelope;
}
