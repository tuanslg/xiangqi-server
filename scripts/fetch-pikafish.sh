#!/usr/bin/env bash
# Downloads a pinned Pikafish release, verifies its checksum and installs the
# binary + NNUE network into ./engine (or $1). Pikafish is GPL-3.0; the NNUE
# weights forbid commercial use without permission (see NNUE-License.md).
set -euo pipefail

TAG="Pikafish-2026-09-06"
ASSET="Pikafish.2026-09-06.7z"
SHA256="41952bbfe2520faceb5902c69e6ab4845cc999841d2b49a95cc1be7867a25e5b"
URL="https://github.com/official-pikafish/Pikafish/releases/download/${TAG}/${ASSET}"

OUT="${1:-$(dirname "$0")/../engine}"

case "$(uname -s)-$(uname -m)" in
  Darwin-*) BIN="Pikafish-MacOS-universal" ;;
  Linux-x86_64) BIN="Pikafish-Linux-x86-64-universal" ;;
  *) echo "Unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

if [ -x "$OUT/pikafish" ] && [ -f "$OUT/pikafish.nnue" ]; then
  echo "Pikafish already installed in $OUT"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $URL"
curl -fsSL -o "$TMP/$ASSET" "$URL"

if command -v sha256sum >/dev/null; then ACTUAL="$(sha256sum "$TMP/$ASSET" | cut -d' ' -f1)"
else ACTUAL="$(shasum -a 256 "$TMP/$ASSET" | cut -d' ' -f1)"; fi
if [ "$ACTUAL" != "$SHA256" ]; then
  echo "Checksum mismatch: expected $SHA256, got $ACTUAL" >&2
  exit 1
fi

mkdir -p "$TMP/x" "$OUT"
if command -v 7zz >/dev/null; then 7zz x -y -o"$TMP/x" "$TMP/$ASSET" >/dev/null
elif command -v 7z >/dev/null; then 7z x -y -o"$TMP/x" "$TMP/$ASSET" >/dev/null
elif command -v bsdtar >/dev/null; then bsdtar -xf "$TMP/$ASSET" -C "$TMP/x"
else echo "Need 7z, 7zz or bsdtar to extract the archive" >&2; exit 1; fi

install -m 0755 "$TMP/x/$BIN" "$OUT/pikafish"
install -m 0644 "$TMP/x/pikafish.nnue" "$OUT/pikafish.nnue"
install -m 0644 "$TMP/x/NNUE-License.md" "$TMP/x/Copying.txt" "$OUT/"
echo "Installed Pikafish to $OUT"
