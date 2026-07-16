# codex-relay-e2ee

An end-to-end encrypted Codex relay for [Pi](https://github.com/earendil-works/pi-mono).

It has two components:

- a relay server running on a host that owns an `openai-codex` OAuth login
- a Pi extension that encrypts requests and reconstructs assistant streams on the client

The relay only exposes its authenticated-encryption protocol. It does not provide a
plaintext OpenAI-compatible API.

```text
Pi + codex-relay-e2ee extension
  -> AES-256-GCM encrypted HTTP
  -> relay server
  -> ChatGPT Codex
```

## Requirements

- Node.js 22.19 or newer on the relay host
- Pi `0.80.7` or newer on the client
- an `openai-codex` OAuth login in Pi on the relay host
- SSH or another way for the client to reach the loopback-bound relay

## Relay server

Clone the repository on the OAuth host and install only the server dependencies:

```bash
git clone https://github.com/alexei-ciobanu/codex-relay-e2ee.git
cd codex-relay-e2ee
npm run server:install
```

If needed, create the shared 32-byte key:

```bash
npm run generate-key
```

The default key path is:

```text
~/.config/codex-relay-e2ee/key
```

Start the server:

```bash
npm start
```

The default listener is `http://127.0.0.1:8787`. Configuration:

| Variable | Default |
|---|---|
| `CODEX_RELAY_HOST` | `127.0.0.1` |
| `CODEX_RELAY_PORT` | `8787` |
| `CODEX_RELAY_KEY_FILE` | `~/.config/codex-relay-e2ee/key` |
| `CODEX_RELAY_MAX_BODY_BYTES` | `52428800` |

The relay host must already have a Codex OAuth login. Run Pi there and use:

```text
/login openai-codex
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

```json
{"ok":true,"protocol":1,"nativeCompaction":true}
```

## Pi extension

Install directly from GitHub on the client:

```bash
pi install git:github.com/alexei-ciobanu/codex-relay-e2ee
```

Copy the same key from the relay host to:

```text
~/.config/codex-relay-e2ee/key
```

and protect it:

```bash
chmod 600 ~/.config/codex-relay-e2ee/key
```

The extension defaults to `http://127.0.0.1:8787`. Optional client overrides:

```text
CODEX_RELAY_URL
CODEX_RELAY_KEY_FILE
```

Run Pi with a relay model:

```bash
pi --provider codex-relay-e2ee --model gpt-5.6-luna
```

Registered models:

- `gpt-5.3-codex-spark`
- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.5`
- `gpt-5.6-luna`
- `gpt-5.6-sol`
- `gpt-5.6-terra`

## SSH forwarding

Keep the relay bound to loopback and forward it to the client:

```sshconfig
Host codex-relay-8787
    HostName relay.example.com
    User relay-user
    LocalForward 127.0.0.1:8787 127.0.0.1:8787
    ExitOnForwardFailure yes
```

```bash
ssh -N codex-relay-8787
```

## Native OpenAI compaction

Install the companion extension:

```bash
pi install git:github.com/alexei-ciobanu/pi-openai-compaction
```

The extensions discover each other through an in-process transport registry. Native
compact requests, responses, and opaque replay plans remain encrypted between the Pi
client and the relay. No provider allow-list override is needed.

## Protocol and security

See [`docs/protocol.md`](docs/protocol.md) for the wire protocol and threat model.

The protocol protects prompts, tools, tool arguments, model responses, usage, native
compaction data, and provider errors from network and TLS-interception observers. It
does not protect against compromise of either endpoint, key theft, plaintext Pi
session files, traffic analysis, or denial of service.

## Development

```bash
npm run check
npm test
```

The root package is intentionally lightweight so Pi can install the extension without
installing the relay server's dependency tree. Server dependencies and their lockfile
live under `server/`.

## License

MIT
