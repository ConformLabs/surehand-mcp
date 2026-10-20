#!/bin/bash
# Shared by the Surehand MCP package's scripts (sourced): where things are, and how to run the installed server.
# Arguments from Installer to the script that sources this: $1 package path, $2 install location (the payload root,
# ~/.surehand), $3 target volume. Never fails the package: problems go to ~/.surehand/ae/install.log.

# The home folder this package was installed into: the parent of the payload root, else $HOME.
DEST="${2:-}"
case "$DEST" in
  */.surehand) TARGET_HOME="${DEST%/.surehand}" ;;
  *) TARGET_HOME="${HOME:-}" ;;
esac
[ -n "$TARGET_HOME" ] && [ -d "$TARGET_HOME/.surehand" ] || TARGET_HOME="$HOME"

SUREHAND="$TARGET_HOME/.surehand"
APPDIR="$SUREHAND/ae"
LOG="$APPDIR/install.log"
NODE="$SUREHAND/node/bin/node"
SERVER="$APPDIR/server/surehand-ae.mjs"
mkdir -p "$APPDIR" 2>/dev/null

# A per-user package runs its scripts as the installing user. If one ever runs as root (e.g. sudo installer ...
# -target CurrentUserHomeDirectory), the server runs as the owner of that home folder, never as root.
AS_USER=()
if [ "$(id -u)" = "0" ]; then
  OWNER="$(stat -f %Su "$TARGET_HOME" 2>/dev/null)"
  if [ -z "$OWNER" ] || [ "$OWNER" = "root" ]; then
    echo "ERROR: running as root for $TARGET_HOME; not running the server as root. Re-run the install from the docs." >>"$LOG"
    exit 0
  fi
  chown -R "$OWNER" "$SUREHAND" 2>>"$LOG"
  [ -d "$TARGET_HOME/.aemcp" ] && chown -R "$OWNER" "$TARGET_HOME/.aemcp" 2>>"$LOG"
  AS_USER=(sudo -u "$OWNER" -H)
fi

# Installer gives scripts a minimal PATH; add the usual places for the claude and codex command line tools.
export PATH="/opt/homebrew/bin:/usr/local/bin:$TARGET_HOME/.local/bin:$TARGET_HOME/.volta/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="$TARGET_HOME"

# run_server SECONDS ARGS...: the installed server with these arguments, its output into the log. stdin is /dev/null:
# the server asks nothing without a terminal (it never quits a running Claude Desktop unasked). perl's alarm caps
# the run. Returns the server's exit status.
run_server() {
  local limit="$1"
  shift
  if [ ! -x "$NODE" ] || [ ! -f "$SERVER" ]; then
    echo "ERROR: the server is not installed ($NODE, $SERVER); skipped: $*" >>"$LOG"
    return 1
  fi
  "${AS_USER[@]+"${AS_USER[@]}"}" /usr/bin/env PATH="$PATH" HOME="$TARGET_HOME" AEMCP_NO_UPDATE_CHECK=1 \
    /usr/bin/perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$limit" "$NODE" "$SERVER" "$@" </dev/null >>"$LOG" 2>&1
}
