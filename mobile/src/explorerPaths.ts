/** Each crumb carries an absolute path, including Windows and WSL share roots. */
export function pathCrumbs(path: string): { label: string; path: string }[] {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const out: { label: string; path: string }[] = [];
  if (normalized.startsWith("//")) {
    if (parts.length < 2) return [];
    let p = `//${parts[0]}/${parts[1]}`;
    out.push({ label: parts[1], path: p });
    for (const part of parts.slice(2)) { p += "/" + part; out.push({ label: part, path: p }); }
  } else {
    let p = normalized.startsWith("/") ? "/" : "";
    if (p) out.push({ label: "/", path: "/" });
    for (const part of parts) { p += (p && p !== "/" ? "/" : "") + part; out.push({ label: part, path: /^[A-Za-z]:$/.test(p) ? p + "/" : p }); }
  }
  return out;
}


/** Desktop WSL launch detection uses native UNC separators. Other paths stay unchanged. */
export const launchPath = (path: string) => /^\/\/wsl(?:\.localhost|\$)\//i.test(path) ? path.replace(/\//g, "\\") : path;

export const parentFromPath = (path: string) => {
  const crumbs = pathCrumbs(path);
  return crumbs.length > 1 ? crumbs[crumbs.length - 2].path : null;
};
