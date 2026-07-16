# Protocol

`codex-relay-e2ee` protocol version 1 carries Pi context and Codex native compaction
data over authenticated-encryption envelopes.

## Endpoints

- `POST /e2ee/v1/stream` — encrypted Pi context in, encrypted NDJSON assistant events out
- `POST /e2ee/v1/compact` — encrypted native compact request and response
- `GET /health` — non-sensitive plaintext capability response

The server should normally bind to loopback and be reached through SSH forwarding.

## Cryptography

- 32-byte pre-shared master key
- AES-256-GCM
- HKDF-SHA-256 request and response keys
- fresh random 96-bit nonce for every request and response frame
- request ID, timestamp, operation, direction, and frame sequence authenticated as AAD
- request IDs rejected if replayed within the two-minute replay window
- request timestamps limited to one minute of server clock skew

The canonical wire domain is `codex-relay-e2ee/v1`. Stream and compact traffic use
separate authenticated operation domains, so a valid envelope for one endpoint cannot
be replayed against the other.

## Stream protocol

The encrypted request contains:

- model ID
- provider-neutral Pi context
- supported stream options
- an optional native-compaction replay plan

The relay restores the inner `openai-codex` identity and delegates serialization and
streaming to Pi AI's `openai-codex-responses` provider. It returns independently
authenticated NDJSON frames with strictly increasing sequence numbers.

Before assistant events, the server emits an encrypted `request_template` control
frame. The client caches safe Codex request fields such as tools and reasoning so the
native-compaction transport can reuse them.

The stream must end with an authenticated `done`, `error`, or `fatal` frame. Truncated
streams are rejected by the client.

## Native compaction

The compact endpoint decrypts a Responses-compatible compact request, authenticates to
ChatGPT with the relay host's Pi OAuth credentials, and encrypts the complete upstream
status and body for the client.

For later model requests, the client sends an encrypted replay plan. The relay applies
that plan only after Pi AI builds the actual Codex Responses payload, preserving fresh
prompt-envelope fields while replacing Pi's textual checkpoint with OpenAI's opaque
compacted window and live tail.

## Threat model

Protected against an observer that can capture, redirect, modify, truncate, replay, or
TLS-intercept traffic but cannot read the PSK or compromise either process.

Not protected against:

- compromise of the Pi client or relay host
- key-file or process-memory access
- plaintext session or debug artifacts
- traffic timing and approximate-size analysis
- denial of service
