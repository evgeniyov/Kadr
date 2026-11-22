#!/bin/bash
# Builds the universal (arm64 + x86_64) macOS helper into resources/bin/mac/kadr-helper.
#
#   bash native/mac/build.sh           # rebuild only when sources changed
#   bash native/mac/build.sh --force   # always rebuild
#
# Env: KADR_SIGN_IDENTITY — codesign identity (default "-" = ad-hoc). electron-builder
# re-signs the binary with the app's identity when packaging.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT_DIR="$ROOT/resources/bin/mac"
OUT="$OUT_DIR/kadr-helper"
MIN_MACOS="13.0"
IDENTITY="${KADR_SIGN_IDENTITY:--}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "kadr-helper: macOS only, skipping" >&2
  exit 0
fi

SOURCES=()
for f in "$HERE"/*.swift; do SOURCES+=("$f"); done

# Idempotent: skip when the binary is newer than every source file and this script.
if [[ "${1:-}" != "--force" && -x "$OUT" ]]; then
  stale=0
  for f in "${SOURCES[@]}" "$HERE/build.sh"; do
    if [[ "$f" -nt "$OUT" ]]; then stale=1; break; fi
  done
  if [[ $stale -eq 0 ]] && codesign --verify "$OUT" 2>/dev/null; then
    echo "kadr-helper is up to date: $OUT"
    exit 0
  fi
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/kadr-helper-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

SDK="$(xcrun --sdk macosx --show-sdk-path)"
for arch in arm64 x86_64; do
  echo "compiling ${arch}…"
  xcrun --sdk macosx swiftc \
    -O -whole-module-optimization \
    -swift-version 5 \
    -target "$arch-apple-macos$MIN_MACOS" \
    -sdk "$SDK" \
    -module-name KadrHelper \
    -module-cache-path "$WORK/module-cache" \
    -Xlinker -weak_framework -Xlinker Translation \
    -o "$WORK/kadr-helper-$arch" \
    "${SOURCES[@]}"
done

lipo -create -output "$WORK/kadr-helper" "$WORK/kadr-helper-arm64" "$WORK/kadr-helper-x86_64"
chmod 755 "$WORK/kadr-helper"
codesign --sign "$IDENTITY" --force --identifier com.kadr.helper "$WORK/kadr-helper"

# Copy next to the target, then rename (atomic, same directory): a running helper keeps
# its old, still-valid inode instead of being overwritten in place.
mkdir -p "$OUT_DIR"
cp "$WORK/kadr-helper" "$OUT_DIR/.kadr-helper.new"
mv -f "$OUT_DIR/.kadr-helper.new" "$OUT"

lipo -info "$OUT"
codesign --verify --verbose=1 "$OUT"
echo "built $OUT"
