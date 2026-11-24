import type { HostInfo } from "./remoteHosts";

/** Whether the header PC selector shows. Nothing paired: never. Another PC in front: always (it is the way back). This PC in front: only while a paired PC is connected and the "always show" setting is on. */
export function hostSelectorVisible(hosts: Pick<HostInfo, "status">[], remoteInFront: boolean, always: boolean): boolean {
  if (hosts.length === 0) return false;
  if (remoteInFront) return true;
  return always && hosts.some((h) => h.status === "online");
}
