// Feeds the phone's usage view: watches the pinned plugins' usage and
// refreshes whenever the pinned set changes.
import { useEffect, useRef, type MutableRefObject } from "react";
import { watchUsageForRemote, type UsageWatch } from "../plugins/remotePublish";
import type { PluginDef } from "../plugins/types";

export function useUsageWatch(allPluginsRef: MutableRefObject<PluginDef[]>, quickActionIds: string[]) {
  const usageWatchRef = useRef<UsageWatch | null>(null);
  useEffect(() => {
    const watch = watchUsageForRemote((id) => allPluginsRef.current.find((p) => p.id === id)?.label ?? id);
    usageWatchRef.current = watch;
    return () => {
      usageWatchRef.current = null;
      watch.dispose();
    };
  }, []);
  const quickActionsKey = quickActionIds.join(" ");
  useEffect(() => usageWatchRef.current?.refresh(), [quickActionsKey]);
}
