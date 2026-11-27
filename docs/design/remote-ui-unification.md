# One UI for local and remote PCs

Status: phase 1 (History) in progress, 2026-11-27. Phases 2-4 are planned only.

## Problem

`src/remoteHosts/` grew a copy of most local panels. The local components call
Tauri `invoke` directly, so the PC-to-PC client (which talks to the other PC
through `hostRequest` / `sendToHost`) got its own component each time. The
copies drift: a local fix or feature does not reach the remote one.

- The remote search bar lost its row wrapper (fixed in faf299b).
- History deletion existed only locally until 6c1b078.

## Pattern

One presentational component, plus a "source" with the data and actions,
implemented twice:

- local: `invoke(...)`, stores, local tabs;
- remote: `hostRequest(...)`, `sendToHost(...)`, `useHostState(hostId)`.

An action the remote cannot do (show in file manager, local-only delegate data)
is an optional prop: absent means the UI hides that item. A remote action that
needs a newer host is gated on `host.caps`. Precedent: `shared/ProviderAuthDialog.tsx`
takes a `transport` and serves desktop, PC-to-PC and phone.

## Inventory (lines, 2026-11-27)

| Remote copy | Local counterpart | Shared today | Phase |
|---|---|---|---|
| RemoteHistoryPanel 304 | AgentHistoryPanel 606 | historyRows, historyDeleteUi | 1 |
| RemoteExplorer 115 | sidebar/FileTree 813 | fileIcons | 2 |
| RemoteFileViewer 87, RemoteDiffViewer 68 | browser panel file view, git/DiffView | DiffView | 2 |
| RemoteNewTabDialog 113 | newtab/* | cliInfo | 3 |
| RemoteAgentPanel 194 | agents/AgentInsightPanel | AgentInsightPanel | 3 (check) |
| RemoteTabStrip 232, RemoteSidebar 101 | terminal/TabStrip, sidebar/Sidebar | TabStrip pieces, GitDock | 4 |
| RemoteChatView 143 + useRemoteChat 507 | chat views | agentViews registry, ChatBody | already unified via adapter |
| RemoteTerminalView 313 | terminal view | theme/link helpers | 4 (check) |

## Phases

1. **History** (now): `agents/HistoryView.tsx` holds the markup, menus, delete
   flow and footer; `AgentHistoryPanel` and `RemoteHistoryPanel` become thin
   data containers.
2. **Explorer + file/diff viewers**: `FileTree` takes a file-system source
   (list, watch, rename, delete, duplicate, create, open). The host's `fs`
   request already has `list`, `read`, `delete`, `create`, `rename`, `move`
   and `write`, so the remote gets those with no protocol change. Missing on
   the host: `duplicate`, directory watch (use polling), search, and file
   info. Those stay optional props until a host op exists. `remoteFiles.ts`
   is already half of the remote source.
3. **New tab dialog + agent panel**: one dialog fed with the folder lister and
   the agent list. The remote shows only what the host reports (profiles,
   available agents).
4. **Tab strip, sidebar, terminal view**: check case by case. They mostly
   reuse local pieces already, so they get merged only where they have
   diverged.

## Rule for new features

From now on, a panel feature is built in the shared component, with a source
method per side. If the remote cannot support it yet, the prop stays optional
and the gap is written here.
