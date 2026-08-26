#!/bin/bash
# P3-6 — redeploy the fork patch onto the BrowserOS neo .app bundle.
#
# When to run: after a MANUAL BrowserOS update (Sparkle auto-updates are
# disabled for this machine — see roadmap P3-6 notes; a manual update
# replaces the whole .app and wipes the patch below) or after a fresh
# `cargo build --release` / `bun scripts/pack-fork.mjs` when you want to
# ship a newer server or hub.
#
# Idempotent: the 0.0.28 bundled backup is only taken once; reruns just
# overwrite the patched binaries and refresh resources/hub.
#
# After running: restart the browser (server restarts from the patched
# bundle and re-provisions ~/.hub/bin/hub on startup).
set -euo pipefail

APP="/Applications/BrowserOS neo.app"
R="$APP/Contents/Resources/BrowserClawServer/default/resources"
FORK_BIN="$HOME/repos/BrowserOS/packages/browseros-agent/target/release/browseros-claw-server-rs"
HUB_DIST="$(cd "$(dirname "$0")/.." && pwd)/hub-dist"

fail() { echo "[deploy-fork-app] $1" >&2; exit 1; }

[ -d "$R" ] || fail "BrowserOS neo not installed at: $APP"
[ -x "$FORK_BIN" ] || fail "fork server binary missing: $FORK_BIN (run cargo build --release in ~/repos/BrowserOS)"
[ -f "$HUB_DIST/bin/bun-runtime" ] || fail "hub-dist missing: $HUB_DIST (run: bun scripts/pack-fork.mjs)"

echo "[deploy-fork-app] fork server: $($FORK_BIN --version)"
echo "[deploy-fork-app] hub dist:    $HUB_DIST"

# 1. one-time backup of the pristine bundled server (0.0.28)
if [ ! -f "$R/bin/browseros-claw-server.orig-0.0.28.bak" ]; then
  cp "$R/bin/browseros-claw-server" "$R/bin/browseros-claw-server.orig-0.0.28.bak"
  echo "[deploy-fork-app] pristine bundled server backed up (first run only)"
fi

# 2. swap in the fork server
cp "$FORK_BIN" "$R/bin/browseros-claw-server"
echo "[deploy-fork-app] bundled server -> fork $($FORK_BIN --version)"

# 3. refresh the hub distribution (rm+cp: bun binary may be replaced in place)
rm -rf "$R/hub"
cp -R "$HUB_DIST" "$R/hub"
echo "[deploy-fork-app] resources/hub refreshed ($(du -sh "$R/hub" | cut -f1))"

# 4. keep Sparkle auto-update suppressed (a manual update resets the .app,
#    not user-level prefs — but reasserting is free)
defaults write com.browseros.BrowserClaw SUEnableAutomaticChecks -bool false
defaults write com.browseros.BrowserClaw SUAllowsAutomaticUpdates -bool false
defaults write com.browseros.BrowserClaw SUAutomaticallyUpdate -bool false

echo "[deploy-fork-app] done — restart the browser to activate."
echo "[deploy-fork-app] verify after restart: ~/.hub/bin/hub --version (wrapper regenerates via hub_provision)"
