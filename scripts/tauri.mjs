// `npm run tauri ...`: the Tauri CLI, with the build environment whisper.cpp
// needs on Windows (dictation, src-tauri/src/dictation). Its default MSVC
// build runs inference ~20x slower than clang-cl + Ninja, so those are forced
// here when they're installed. Plain `cargo check/test/build` on Windows needs
// the same variables: see scripts/cargo-env.ps1. Other OSes need nothing.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Directories of a WinGet package whose folder name starts with `prefix`, plus `sub`. */
function wingetDirs(prefix, sub) {
  const root = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages");
  if (!existsSync(root)) return [];
  const dirs = [];
  for (const pkg of readdirSync(root)) {
    if (!pkg.startsWith(prefix)) continue;
    const base = join(root, pkg);
    dirs.push(join(base, sub));
    for (const inner of readdirSync(base, { withFileTypes: true })) {
      if (inner.isDirectory()) dirs.push(join(base, inner.name, sub));
    }
  }
  return dirs;
}

if (process.platform === "win32") {
  const env = process.env;
  const llvm = "C:\\Program Files\\LLVM\\bin";
  const extra = [
    llvm,
    "C:\\Program Files\\CMake\\bin",
    ...wingetDirs("Kitware.CMake", "bin"),
    ...wingetDirs("Ninja-build.Ninja", "."),
  ].filter((dir) => existsSync(dir));
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = [...extra, env[pathKey] ?? ""].join(delimiter);
  // Without LLVM the build falls back to MSVC: slow, but it still builds.
  const defaults = existsSync(llvm)
    ? {
        CMAKE_GENERATOR: "Ninja",
        CMAKE_C_COMPILER: "clang-cl",
        CMAKE_CXX_COMPILER: "clang-cl",
        CXXFLAGS: "-EHsc",
        GGML_CCACHE: "OFF",
        LIBCLANG_PATH: llvm,
      }
    : {};
  for (const [key, value] of Object.entries(defaults)) env[key] ??= value;
}

const bin = join("node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
const child = spawn(bin, process.argv.slice(2), { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
