# Protocol

`pi-model-relay-e2ee` protocol version 2 carries model catalogs, Pi contexts, assistant events, and native Responses
compaction over authenticated-encryption envelopes.

Version 2 intentionally has no compatibility with the earlier Codex-only protocol.

## Endpoints

- `POST /e2ee/v2/models` — encrypted request and sanitized authenticated model catalog
- `POST /e2ee/v2/stream` — encrypted Pi context in, encrypted NDJSON assistant events out
- `POST /e2ee/v2/compact` — encrypted native compact request and response
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

The canonical wire domain is `pi-model-relay-e2ee/v2`. Models, stream, and compact traffic use separate authenticated
operation domains, so a valid envelope for one endpoint cannot be replayed against another.

## Model catalog

The encrypted catalog contains only routing and Pi model metadata. It never contains provider credentials, resolved
headers, auth sources, or upstream endpoint overrides. Relay model IDs combine the upstream provider and model ID, for
example `xai/grok-4.5`.

The server builds the catalog from Pi `ModelRuntime.getAvailable()` and applies optional provider/model allowlists. The
client validates the catalog, caches the last known good result, and publishes it through Pi's `refreshModels` API.

## Stream protocol

The encrypted request contains:

- relay model ID
- provider-neutral Pi context
- supported stream options
- an optional native-compaction replay plan

The server resolves the real upstream model and delegates authentication, serialization, and streaming to Pi's
`ModelRuntime`. Assistant messages retain authenticated source identity so cross-model and cross-provider histories can
be restored correctly on subsequent relay requests.

For Responses-compatible models, the server emits an encrypted `request_template` control frame before assistant
events. The client caches safe request fields such as tools and reasoning so native compaction can reuse them.

The stream must end with an authenticated `done`, `error`, or `fatal` frame. Truncated streams are rejected by the
client.

## Native compaction

Native compaction capability is advertised per model with an API family and an explicit provider contract:

- public OpenAI: `canonical-window`
- OpenAI Codex subscription: `codex-fresh-context`
- xAI: `xai-compaction-head`

OpenAI Codex uses `openai-codex-responses`; public OpenAI and xAI use `openai-responses`. Other
Responses-compatible providers are not assumed to support native compaction without primary-source evidence.

The compact endpoint resolves authentication through the same Pi model runtime and encrypts the complete result for
the client. Public OpenAI and xAI use their standalone compact endpoints. Codex uses a streamed normal Responses
request with a trailing `compaction_trigger` and the `remote_compaction_v2` beta feature; the relay extracts exactly
one opaque compaction item and normalizes retained user messages plus that item into the existing encrypted response
contract.

This normal streaming route replaced the unavailable internal Codex `/backend-api/codex/responses/compact` route; it
does not imply deprecation of the separately documented public OpenAI `/v1/responses/compact` API. The migration record
and diagnosis checklist are maintained in the companion extension's
[`Codex remote compaction v2 note`](https://github.com/alexei-ciobanu/pi-openai-compaction/blob/main/docs/codex-remote-compaction-v2.md).

For later requests, the client sends a version 2 encrypted replay plan that separates the complete compacted window
from the live post-compaction tail. The server applies it only after Pi builds the real provider payload. It preserves
public OpenAI's canonical window unchanged, removes fresh prompt envelopes for xAI, and injects fresh provider-authored
context after the compacted window for normal Codex post-compaction turns.

The primary-source justification and captured provider documentation live in the
[`pi-openai-compaction` provider contract documentation](https://github.com/alexei-ciobanu/pi-openai-compaction/blob/main/docs/provider-compaction-contracts.md).

## Threat model

Protected against an observer that can capture, redirect, modify, truncate, replay, or TLS-intercept traffic but cannot
read the PSK or compromise either process.

Not protected against:

- compromise of the Pi client or relay host
- key-file or process-memory access
- plaintext session or debug artifacts
- traffic timing and approximate-size analysis
- denial of service
- an authorized PSK holder using any model permitted by the relay allowlists
