#!/bin/zsh -l
# Builds VibeCut Agent as a real app and installs it as ~/Applications/VibeCut Agent.app, so it opens
# from Spotlight, Launchpad or the Dock (and, if Settings → Window says so, at login). Re-run it after
# pulling changes: it quits the installed copy, replaces it and opens the new one.
#
# A login shell, so npm, cargo and uv are on PATH as in a terminal. Run it as `npm run install-app`.

set -u
REPO="${0:A:h:h}"
NAME="VibeCut Agent"
APP="$HOME/Applications/$NAME.app"
BUILT="$REPO/src-tauri/target/release/bundle/macos/$NAME.app"

say() { print -P "%B==>%b $*"; }
fail() { print -P "%F{red}$*%f" >&2; exit 1; }

for tool in npm cargo uv; do
  command -v "$tool" >/dev/null || fail "$tool isn't installed or isn't on PATH. Install it, then run this again."
done

cd "$REPO" || fail "Can't open $REPO"
[[ -d node_modules ]] || { say "Installing the npm packages"; npm ci || fail "npm ci failed"; }

# Sign with a lasting identity, so macOS sees each new build as the same app: the Keychain then keeps
# letting it read its API keys (an ad-hoc signature changes every build, and each one asks again).
# VIBECUT_SIGNING_IDENTITY picks one; otherwise the first "Apple Development" identity is used.
identity="${VIBECUT_SIGNING_IDENTITY:-}"
if [[ -z "$identity" ]]; then
  identity=$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/^ *[0-9]*) [0-9A-F]* "\(Apple Development: .*\)"$/\1/p' | head -1)
fi
if [[ -n "$identity" ]]; then
  say "Signing as $identity"
  export APPLE_SIGNING_IDENTITY="$identity"
else
  print -P "%F{yellow}No signing identity found, so the build is signed ad hoc: after each update, macOS asks again"
  print -P "before the app reads its keys from the Keychain. Set VIBECUT_SIGNING_IDENTITY to fix that.%f"
fi

say "Building $NAME (the first build takes a few minutes)"
npx tauri build --bundles app || fail "The build failed; see above."
[[ -d "$BUILT" ]] || fail "The build didn't make $BUILT"

if pgrep -f "$APP/Contents/MacOS/" >/dev/null; then
  say "Quitting the installed copy"
  # A real Quit, so the app stops its Python helpers on the way out.
  osascript -e "tell application \"$APP\" to quit" >/dev/null 2>&1
  for _ in {1..20}; do
    pgrep -f "$APP/Contents/MacOS/" >/dev/null || break
    sleep 0.5
  done
  pgrep -f "$APP/Contents/MacOS/" >/dev/null && fail "$NAME didn't quit. Quit it from its menu-bar icon, then run this again."
fi

say "Installing $APP"
mkdir -p "$HOME/Applications"
rm -rf "$APP"
ditto "$BUILT" "$APP" || fail "Couldn't copy the app into ~/Applications"
touch "$APP"

if pgrep -f "target/debug/vibecut-agent" >/dev/null; then
  print "\nInstalled. A dev build (npm run tauri dev) is running, so the app wasn't opened: two copies would"
  print "both watch the editors. Quit the dev build, then open $NAME from Spotlight."
else
  say "Opening $NAME"
  open "$APP"
fi

print "\nNext:"
print "  • Its first launch sets up Python in its app data folder, which takes a minute."
print "  • It doesn't read the repo's .env: put the API keys in Settings → API keys (they go in the Keychain)."
print "  • Settings → Window → Open at login starts it in the menu bar when you log in."
print "  • After pulling changes, run npm run install-app again."
