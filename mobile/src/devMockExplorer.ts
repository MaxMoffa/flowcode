// DEV ONLY: filesystem replies for the browser preview. Never touches real files.
import { emit } from "@tauri-apps/api/event";
import type { ClientMsg, FsResponse } from "../../shared/remote-types";

const home = "C:/Users/massi";
type Node = { dir: boolean; text?: string; version: number; truncated?: boolean; binary?: boolean };
const tree = new Map<string, Node>();
const dir = (path: string) => tree.set(path, { dir: true, version: 1 });
for (const path of ["C:/", "C:/Users", home, home + "/Progetti", home + "/Progetti/flowcode", home + "/Progetti/flowcode/src", home + "/Progetti/flowcode/mobile", home + "/Progetti/docs", home + "/api", home + "/archivio", "//wsl.localhost/Ubuntu", "//wsl.localhost/Ubuntu/home", "//wsl.localhost/Ubuntu/home/massi", "//wsl.localhost/Ubuntu/home/massi/api"]) dir(path);
tree.set(home + "/Progetti/flowcode/README.md", { dir: false, text: "# Flowcode\n\nTerminali e agenti, dal computer e dal telefono.\n", version: 1 });
tree.set(home + "/Progetti/flowcode/build.log", { dir: false, text: "File molto grande: anteprima parziale.\n", version: 1, truncated: true });
tree.set(home + "/Progetti/flowcode/logo.png", { dir: false, version: 1, binary: true });
const clean = (path: string) => /^[A-Za-z]:\/$/.test(path) ? path : path.replace(/\/$/, "");
const parent = (path: string) => /^[A-Za-z]:\/$/.test(path) || /^\/\/[^/]+\/[^/]+$/.test(path) ? null : clean(path.slice(0, path.lastIndexOf("/")) + "/");

export function explorerMock(msg: ClientMsg | undefined) {
  if (msg?.t !== "fs") return;
  const { request: r, requestId } = msg;
  let response: FsResponse | undefined;
  let error: string | undefined;
  try {
    if (r.op === "roots") response = { kind: "roots", roots: [{ name: "Cartella utente", path: home }, { name: "C:/", path: "C:/" }, { name: "WSL · Ubuntu", path: "//wsl.localhost/Ubuntu" }] };
    else {
      const path = clean(r.path);
      const node = tree.get(path);
      if (!node) throw Error("Percorso non trovato");
      switch (r.op) {
        case "list": {
          if (!node.dir) throw Error("Non è una cartella");
          const prefix = path.replace(/\/$/, "") + "/";
          const entries = [...tree].filter(([p]) => p.startsWith(prefix) && p !== path && !p.slice(prefix.length).includes("/"))
            .map(([p, n]) => ({ name: p.slice(prefix.length), dir: n.dir, ...(!n.dir ? { size: n.text?.length ?? 100 } : {}) }))
            .sort((a,b) => Number(b.dir)-Number(a.dir) || a.name.localeCompare(b.name));
          response = { kind: "list", path, parent: parent(path), entries, truncated: false }; break;
        }
        case "read":
          if (node.binary) throw Error("File binario: non si può mostrare");
          response = { kind: "file", path, text: node.text ?? "", truncated: !!node.truncated, version: node.truncated ? null : String(node.version) }; break;
        case "write":
          if (String(node.version) !== r.version || node.truncated) throw Error("Il file è cambiato sul computer. Riaprilo prima di salvare.");
          node.text = r.text; node.version++; response = { kind: "done", path }; break;
        case "create": {
          const target = path.replace(/\/$/, "") + "/" + r.name;
          if (!r.name.trim() || r.name.includes("/") || tree.has(target)) throw Error("Nome non valido o già esistente");
          tree.set(target, { dir: r.dir, text: "", version: 1 }); response = { kind: "done", path: target }; break;
        }
        case "rename":
        case "move": {
          const destination = r.op === "move" ? clean(r.destination) : parent(path)!;
          const name = r.op === "move" ? path.split("/").pop()! : r.name;
          const target = destination.replace(/\/$/, "") + "/" + name;
          if (tree.has(target) || destination.startsWith(path) || !tree.get(destination)?.dir) throw Error("Destinazione non valida");
          for (const [p,n] of [...tree]) if (p === path || p.startsWith(path + "/")) { tree.delete(p); tree.set(target+p.slice(path.length),n); }
          response = { kind: "done", path: target }; break;
        }
        case "delete":
          for (const p of [...tree.keys()]) if (p === path || p.startsWith(path + "/")) tree.delete(p);
          response = { kind: "done", path }; break;
      }
    }
  } catch (e) { error = String((e as Error).message); }
  setTimeout(() => void emit("remote://msgs", [{ t: "fs", requestId, response, error }]), 60);
}
