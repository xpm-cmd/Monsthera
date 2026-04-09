#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN_DIR="$ROOT_DIR/.monsthera/bin"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="darwin" ;;
  Linux) PLATFORM="linux" ;;
  *)
    echo "Unsupported operating system: $OS" >&2
    exit 1
    ;;
esac

case "$ARCH" in
  arm64|aarch64) TARGET_ARCH="arm64" ;;
  x86_64|amd64) TARGET_ARCH="amd64" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

VERSION="${DOLT_VERSION:-latest}"
ASSET="dolt-${PLATFORM}-${TARGET_ARCH}.tar.gz"

if [[ "$VERSION" == "latest" ]]; then
  URL="https://github.com/dolthub/dolt/releases/latest/download/${ASSET}"
else
  URL="https://github.com/dolthub/dolt/releases/download/${VERSION}/${ASSET}"
fi

mkdir -p "$BIN_DIR"

echo "Downloading Dolt from $URL"
curl -fsSL "$URL" -o "$TMP_DIR/dolt.tar.gz"
tar -xzf "$TMP_DIR/dolt.tar.gz" -C "$TMP_DIR"

EXTRACTED_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name 'dolt-*' | head -n 1)"
if [[ -z "$EXTRACTED_DIR" ]]; then
  echo "Failed to find extracted Dolt archive contents" >&2
  exit 1
fi

cp "$EXTRACTED_DIR/bin/dolt" "$BIN_DIR/dolt"
chmod +x "$BIN_DIR/dolt"

echo "Installed Dolt to $BIN_DIR/dolt"
"$BIN_DIR/dolt" version
