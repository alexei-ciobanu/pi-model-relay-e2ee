#!/usr/bin/env bash
set -euo pipefail

umask 077

DEFAULT_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pi-model-relay-e2ee"
OUTPUT_FILE="${1:-$DEFAULT_CONFIG_DIR/key}"

if [[ -e "$OUTPUT_FILE" ]]; then
  echo "Refusing to overwrite existing relay key: $OUTPUT_FILE" >&2
  exit 1
fi

mkdir -p "$(dirname -- "$OUTPUT_FILE")"
openssl rand 32 >"$OUTPUT_FILE"
chmod 600 "$OUTPUT_FILE"

size="$(wc -c <"$OUTPUT_FILE" | tr -d '[:space:]')"
if [[ "$size" != "32" ]]; then
  rm -f "$OUTPUT_FILE"
  echo "Key generation failed: expected 32 bytes, got $size" >&2
  exit 1
fi

echo "Generated 32-byte pi-model-relay-e2ee key: $OUTPUT_FILE"
echo "Copy this file securely to each Pi client at the same default path."
