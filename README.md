# pi-model-relay-e2ee

An end-to-end encrypted relay for models authenticated in
[Pi](https://github.com/earendil-works/pi).

It has two components:

- a relay server on the host that owns Pi provider logins
- a Pi extension on another machine that discovers and uses those models without copying provider credentials

```text
Pi + pi-model-relay-e2ee extension
  -> AES-256-GCM encrypted HTTP
  -> relay server + Pi ModelRuntime
  -> authenticated upstream provider
```

The relay exposes Pi's standard assistant event protocol inside authenticated-encryption envelopes. It does not expose
provider credentials or a plaintext OpenAI-compatible endpoint.

## Requirements

- Node.js 22.19 or newer on the relay host
- Pi `0.80.10` or newer on the client
- one or more provider logins or API keys configured on the relay host
- SSH or another way for the client to reach the loopback-bound relay

## Relay server

Clone the repository on the authenticated host and install the server dependencies:

```bash
git clone https://github.com/alexei-ciobanu/pi-model-relay-e2ee.git
cd pi-model-relay-e2ee
npm run server:install
```

Configure providers in Pi on that host, for example:

```text
/login openai-codex
/login xai
```

Create the shared 32-byte key:

```bash
npm run generate-key
```

The default key path is:

```text
~/.config/pi-model-relay-e2ee/key
```

Start the server:

```bash
npm start
```

The default listener is `http://127.0.0.1:8787`.

| Variable | Default |
|---|---|
| `PI_MODEL_RELAY_HOST` | `127.0.0.1` |
| `PI_MODEL_RELAY_PORT` | `8787` |
| `PI_MODEL_RELAY_KEY_FILE` | `~/.config/pi-model-relay-e2ee/key` |
| `PI_MODEL_RELAY_MAX_BODY_BYTES` | `52428800` |
| `PI_MODEL_RELAY_ALLOW_PROVIDERS` | all authenticated providers |
| `PI_MODEL_RELAY_ALLOW_MODELS` | all models on allowed providers |

Allowlist values are comma-separated. Model allowlist entries use relay IDs such as `xai/grok-4.5`.

The server detects changes to Pi's `auth.json`, `models.json`, and `models-store.json` and recreates its model runtime
without requiring a restart.

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## Pi extension

Install directly from GitHub on the client:

```bash
pi install git:github.com/alexei-ciobanu/pi-model-relay-e2ee
```

Copy the shared key to:

```text
~/.config/pi-model-relay-e2ee/key
```

and protect it:

```bash
chmod 600 ~/.config/pi-model-relay-e2ee/key
```

Optional client overrides:

```text
PI_MODEL_RELAY_URL
PI_MODEL_RELAY_KEY_FILE
PI_MODEL_RELAY_MODELS_CACHE_FILE
```

The extension registers the `pi-relay-e2ee` provider. Model IDs include the source provider to avoid collisions:

```bash
pi --provider pi-relay-e2ee --model xai/grok-4.5
pi --provider pi-relay-e2ee --model openai-codex/gpt-5.6-luna
```

The encrypted catalog is cached for four hours. Opening `/model` participates in Pi's model refresh flow; run
`pi update --models` to force an immediate refresh.

## SSH forwarding

Keep the relay bound to loopback and forward it to the client:

```sshconfig
Host pi-model-relay-8787
    HostName relay.example.com
    User relay-user
    LocalForward 127.0.0.1:8787 127.0.0.1:8787
    ExitOnForwardFailure yes
```

```bash
ssh -N pi-model-relay-8787
```

## Native Responses compaction

Install the companion extension:

```bash
pi install git:github.com/alexei-ciobanu/pi-openai-compaction
```

Native compaction is advertised only for upstream providers with an explicit replay contract: public OpenAI uses its
canonical compacted window unchanged, OpenAI Codex uses Responses compaction v2 and refreshes current provider context,
and xAI treats its singleton compact output as the new conversation head. Compact requests, responses, and version 2
replay plans remain inside the encrypted relay protocol. Primary-source citations and captured provider documentation are maintained in the
[`pi-openai-compaction` provider contract documentation](https://github.com/alexei-ciobanu/pi-openai-compaction/blob/main/docs/provider-compaction-contracts.md).

The public OpenAI `/v1/responses/compact` endpoint is distinct from the Codex subscription backend. The legacy internal
`/backend-api/codex/responses/compact` route returned 404 during the v2 migration investigation; Codex now uses the normal
streamed `/backend-api/codex/responses` route with a trailing `compaction_trigger`. The complete migration record,
request/response flow, checkpoint semantics, encryption-layer distinction, and regression checklist are in the
[`Codex remote compaction v2 migration note`](https://github.com/alexei-ciobanu/pi-openai-compaction/blob/main/docs/codex-remote-compaction-v2.md).

## Protocol and security

See [`docs/protocol.md`](docs/protocol.md) for the wire protocol and threat model.

The PSK grants the client access to every model allowed by the server configuration. Protect it like the provider
credentials it represents.

## Development

```bash
npm run check
npm test
```

## License

MIT
