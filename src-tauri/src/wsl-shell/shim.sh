#!/bin/sh
# Flowcode: a coding agent started in a WSL terminal tab comes here first
# (this folder leads PATH, see bashrc). It adds the flags that hand the agent
# Flowcode's MCP server (settings in the tab's FLOWCODE_MCP_* variables), then
# runs the real program found further down PATH. Same rules as
# provider_launcher.rs `mcp_args` on Windows.
cli=${0##*/}
here=${0%/*}
real=
old_ifs=$IFS
IFS=:
for dir in $PATH; do
  [ -n "$dir" ] || continue
  [ "$dir" = "$here" ] && continue
  [ "$dir" = "$FLOWCODE_SHIM_DIR" ] && continue
  if [ -f "$dir/$cli" ] && [ -x "$dir/$cli" ]; then real=$dir/$cli; break; fi
done
IFS=$old_ifs
if [ -z "$real" ]; then
  echo "$cli: command not found" >&2
  exit 127
fi
skip=
[ -n "$FLOWCODE_MCP_TOKEN" ] && [ -n "$FLOWCODE_MCP_TOOLS" ] || skip=1
case "$1" in -v|--version|-h|--help) skip=1 ;; esac
sub=
for arg in "$@"; do
  case "$arg" in -*) ;; *) sub=$arg; break ;; esac
done
case "$cli" in
  claude) case "$sub" in @CLAUDE_SKIP@) skip=1 ;; esac ;;
  codex) case "$sub" in @CODEX_SKIP@) skip=1 ;; esac ;;
esac
if [ -z "$skip" ]; then
  case "$cli" in
    claude)
      export FLOWCODE_MCP_AGENT=claude
      if [ -n "$FLOWCODE_MCP_AUTO_ALLOW" ]; then set -- "--allowedTools=$FLOWCODE_MCP_AUTO_ALLOW" "$@"; fi
      if [ -n "$FLOWCODE_MCP_CLAUDE_CONFIG" ]; then set -- "--mcp-config=$FLOWCODE_MCP_CLAUDE_CONFIG" "$@"; fi
      ;;
    codex)
      case "$FLOWCODE_MCP_SCRIPT" in
        ''|*"'"*) ;;
        *)
          export FLOWCODE_MCP_AGENT=codex
          IFS=,
          for tool in $FLOWCODE_MCP_AUTO_ALLOW; do
            tool=${tool#mcp__flowcode__}
            case "$tool" in
              ''|*[!A-Za-z0-9_]*) ;;
              *) set -- -c "mcp_servers.flowcode.tools.$tool.approval_mode='approve'" "$@" ;;
            esac
          done
          IFS=$old_ifs
          set -- -c "mcp_servers.flowcode.command='node'" -c "mcp_servers.flowcode.args=['$FLOWCODE_MCP_SCRIPT']" -c "mcp_servers.flowcode.env_vars=['FLOWCODE_MCP_DIR','FLOWCODE_MCP_TOKEN','FLOWCODE_MCP_TOOLS','FLOWCODE_MCP_AGENT']" "$@"
          ;;
      esac
      ;;
  esac
fi
exec "$real" "$@"
