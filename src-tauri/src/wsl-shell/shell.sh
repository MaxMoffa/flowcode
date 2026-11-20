#!/bin/sh
# Flowcode: starts the user's login shell for a WSL terminal tab. bash reads
# Flowcode's bashrc, which runs the usual login files and then puts Flowcode's
# agent shims first on PATH (the login files would put ~/.local/bin back in
# front of them). Any other shell starts as it always does.
sh=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)
[ -n "$sh" ] && [ -x "$sh" ] || sh=${SHELL:-/bin/sh}
# Sourced by the tab's start command with this file's path in $1.
self=${1:-$0}
here=${self%/*}
case "${sh##*/}" in
  bash) [ -r "$here/bashrc" ] && exec "$sh" --rcfile "$here/bashrc" -i ;;
esac
exec "$sh" -l
