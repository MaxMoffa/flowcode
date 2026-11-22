#!/bin/sh
# Flowcode: stands in for the commands agents and dev servers use to open a page
# (xdg-open, open, start, wslview, sensible-browser, www-browser, flowcode-open
# which is what BROWSER points to in WSL tabs). A web page - or a previewable
# file, for the commands that take files - goes to Flowcode, whose Browser
# settings decide where it opens. Anything else (`open -a App`, `start notepad`)
# runs the real program further down PATH, as does a page Flowcode did not take.
#
# Transport: FLOWCODE_OPEN_EXE (native tabs and chats) is Flowcode's executable,
# run in its hidden `--flowcode-open` mode, which also opens with the system
# default when Flowcode does not answer. Otherwise (WSL, where the Windows
# executable is not reliably reachable) the request file the MCP server writes
# is written here, from FLOWCODE_MCP_DIR / FLOWCODE_MCP_TOKEN.
# Known gaps, not hackable from here: PowerShell Start-Process, cmd's builtin
# `start` and explorer.exe <url> run outside this folder's PATH lookup.
name=${0##*/}
self=$0
first=
files=
case "$name" in xdg-open|open|wslview|flowcode-open) files=1 ;; esac
skipped=
for arg in "$@"; do
  case "$name:$arg" in
    start:) [ -z "$skipped" ] && { skipped=1; continue; } ;; # start "" <url>: the empty window title
    start:/[A-Za-z]*) case "$arg" in */*/*) ;; *) continue ;; esac ;; # start /b /wait ...
  esac
  case "$arg" in -*) continue ;; esac
  first=$arg
  break
done
target=
case "$first" in
  [Hh][Tt][Tt][Pp]://*|[Hh][Tt][Tt][Pp][Ss]://*) target=$first ;;
  *)
    if [ -n "$files" ] && [ -f "$first" ]; then
      case "$first" in
        *.[Hh][Tt][Mm][Ll]|*.[Hh][Tt][Mm]|*.[Ss][Vv][Gg]|*.[Pp][Dd][Ff])
          case "$first" in /*) target=$first ;; *) target=$PWD/$first ;; esac
          # Git Bash: Flowcode wants the Windows spelling of the path.
          if command -v cygpath >/dev/null 2>&1; then target=$(cygpath -w "$target" 2>/dev/null || printf '%s' "$target"); fi
          ;;
      esac
    fi
    ;;
esac

if [ -n "$target" ]; then
  if [ -n "$FLOWCODE_OPEN_EXE" ]; then
    "$FLOWCODE_OPEN_EXE" --flowcode-open "$target"
    exit $?
  fi
  if [ -n "$FLOWCODE_MCP_DIR" ] && [ -n "$FLOWCODE_MCP_TOKEN" ] && [ -d "$FLOWCODE_MCP_DIR" ]; then
    safe=1
    case "$target" in *\"*|*\\*|*[[:cntrl:]]*) safe= ;; esac
    if [ -n "$safe" ]; then
      id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || printf '%s-%s' "$$" "$(date +%s)")
      cwd=
      case "$PWD" in *\"*|*\\*|*[[:cntrl:]]*) ;; *) cwd=",\"cwd\":\"$PWD\"" ;; esac
      req=$FLOWCODE_MCP_DIR/req-$id.json
      res=$FLOWCODE_MCP_DIR/res-$id.json
      printf '{"id":"%s","token":"%s","tool":"open_in_browser","args":{"target":"%s"},"timeout_ms":4000%s}' "$id" "$FLOWCODE_MCP_TOKEN" "$target" "$cwd" > "$req.tmp" && mv "$req.tmp" "$req"
      tries=0
      while [ $tries -lt 28 ]; do
        sleep 0.15 2>/dev/null || sleep 1
        tries=$((tries + 1))
        if [ -f "$res" ]; then
          answer=$(cat "$res" 2>/dev/null)
          [ -n "$answer" ] || continue
          rm -f "$res"
          case "$answer" in *'"ok":true'*) exit 0 ;; esac
          break
        fi
      done
      rm -f "$req" "$req.tmp"
    fi
  fi
fi

# Not ours (or Flowcode did not answer): the real program, found further down PATH.
find_real() {
  old_ifs=$IFS
  IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] || continue
    [ "$dir/$1" -ef "$self" ] && continue
    [ "$dir" = "$FLOWCODE_SHIM_DIR" ] && continue
    if [ -f "$dir/$1" ] && [ -x "$dir/$1" ]; then IFS=$old_ifs; real=$dir/$1; return 0; fi
  done
  IFS=$old_ifs
  return 1
}
real=
find_real "$name" || {
  # A page Flowcode did not take may be opened by any other opener there is.
  if [ -n "$target" ] || [ "$name" = flowcode-open ]; then
    for other in xdg-open wslview sensible-browser x-www-browser www-browser open; do
      [ "$other" = "$name" ] && continue
      find_real "$other" && break
    done
  fi
}
if [ -z "$real" ]; then
  # Nothing else to run: the Windows side opens it (WSL interop, Git Bash).
  if [ -n "$target" ] && command -v explorer.exe >/dev/null 2>&1; then
    explorer.exe "$target"
    exit 0
  fi
  if [ "$name" = start ] && command -v cmd.exe >/dev/null 2>&1; then exec cmd.exe /c start "" "$@"; fi
fi
if [ -z "$real" ]; then
  echo "$name: command not found" >&2
  exit 127
fi
exec "$real" "$@"
