#!/usr/bin/env bash
# Builds scene/main.cpp into web/atc-engine.{js,wasm} with the Strata 0.10.0
# web kit, and copies the kit's page scripts beside them. Downloads the
# SHA-pinned release into .strata/ (gitignored). Needs emsdk 6.0.11.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
v=0.10.0
sha=bb86b974c7e0309db91625ba5ee157273704c77d93f4338c8a63ee625e3d56de
tar="$repo/.strata/strata-$v-wasm32-emscripten.tar.gz"
if [ -z "${EMSDK_PYTHON:-}" ] || ! command -v emcc >/dev/null; then
  . "${AGENTVIZ_EMSDK_ENV:-/root/agentviz/tools/emsdk-env.sh}"
fi
if [ ! -f "$tar" ]; then
  mkdir -p "$repo/.strata"
  gh release download "v$v" -R Preponderous-Software/strata -p "$(basename "$tar")" -D "$repo/.strata"
fi
echo "$sha  $tar" | sha256sum -c --quiet
[ -f "$repo/.strata/kit/build-kit.sh" ] || tar -xzf "$tar" -C "$repo/.strata"
KIT_WORK="$repo/.strata/work" STRATA_TARBALL="$tar" STRATA_SHA256="$sha" KIT_OUT="$repo/web" "$repo/.strata/kit/build-kit.sh" "$here/kit.conf"
