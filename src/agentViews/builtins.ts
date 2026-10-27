import { lazy } from "react";
import { TERMINAL_VIEW, agentView, registerAgentView } from "./registry";
import type { AgentViewDef } from "./types";

const BUILTINS: AgentViewDef[] = [
  {
    id: "chat",
    labelKey: "agentViews.chat",
    descriptionKey: "agentViews.chat.desc",
    source: "builtin",
    transport: "acp",
    devices: ["desktop", "tablet", "phone"],
    component: lazy(() => import("../chat/ChatBody")),
  },
  {
    id: TERMINAL_VIEW,
    labelKey: "agentViews.terminal",
    descriptionKey: "agentViews.terminal.desc",
    source: "builtin",
    transport: "pty",
    devices: ["desktop", "tablet", "phone"],
  },
];

// The views every install has. Imported for its side effect by the host; a
// hot reload re-runs this module, so an id already there is left alone.
for (const def of BUILTINS) {
  if (!agentView(def.id)) registerAgentView(def);
}
