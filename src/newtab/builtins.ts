import { GlassNewTab } from "./GlassNewTab";
import { NewTabPage } from "./NewTabPage";
import { newTabLayout, registerNewTabLayout } from "./layouts";
import type { NewTabLayoutDef } from "./types";

const BUILTINS: NewTabLayoutDef[] = [
  { id: "terminal", labelKey: "newTab.layout.terminal", source: "builtin", component: NewTabPage },
  { id: "glass", labelKey: "newTab.layout.glass", source: "builtin", component: GlassNewTab },
];

// The layouts every install has. Imported for its side effect by the host; a
// hot reload re-runs this module, so an id already there is left alone.
for (const def of BUILTINS) {
  if (!newTabLayout(def.id)) registerNewTabLayout(def);
}
