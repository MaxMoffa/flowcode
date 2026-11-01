import { beforeEach, describe, expect, it, vi } from "vitest";

const yamlLoad = vi.hoisted(() => ({ calls: 0, fail: false }));
vi.mock("@codemirror/lang-yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codemirror/lang-yaml")>();
  return {
    ...actual,
    yaml: () => {
      yamlLoad.calls++;
      if (yamlLoad.fail) throw new Error("grammar unavailable");
      return actual.yaml();
    },
  };
});

let languageFor: typeof import("./language").languageFor;

beforeEach(async () => {
  vi.resetModules();
  yamlLoad.calls = 0;
  yamlLoad.fail = false;
  ({ languageFor } = await import("./language"));
});

async function treeFor(name: string, doc: string): Promise<string> {
  const [{ EditorState }, { syntaxTree }, grammar] = await Promise.all([
    import("@codemirror/state"), import("@codemirror/language"), languageFor(name),
  ]);
  expect(grammar).not.toBeNull();
  return syntaxTree(EditorState.create({ doc, extensions: grammar ?? [] })).toString();
}

describe("on-demand editor grammars", () => {
  it("returns plain text without loading a grammar for unsupported filenames", async () => {
    for (const name of ["", "README", "notes.txt", ".env", ".gitignore", "file.unknown", "file.constructor", "file.__proto__"]) {
      await expect(languageFor(name)).resolves.toBeNull();
    }
    expect(yamlLoad.calls).toBe(0);
  });

  it.each([
    { names: ["main.js", "main.jsx", "main.mjs", "main.cjs", "MAIN.JS"] },
    { names: ["main.css", "main.scss", "main.sass", "main.less"] },
    { names: ["main.html", "main.htm"] },
    { names: ["main.xml", "main.svg"] },
    { names: ["main.md", "main.mdx"] },
    { names: ["main.yaml", "main.yml"] },
    { names: ["main.sh", "main.bash", "main.zsh", "main.fish"] },
    { names: ["main.c", "main.h"] },
    { names: ["main.cpp", "main.cc", "main.hpp"] },
    { names: ["main.ini", "main.conf", "main.cfg", "main.env"] },
    { names: ["Dockerfile", "dockerfile", "Dockerfile.production"] },
  ])("shares the grammar promise across $names", async ({ names }) => {
    const first = languageFor(names[0]);
    for (const name of names.slice(1)) expect(languageFor(name)).toBe(first);
    await expect(first).resolves.not.toBeNull();
    expect(languageFor(names[0])).toBe(first);
  });

  it("keeps JavaScript, TypeScript and TSX options distinct", async () => {
    const js = languageFor("component.jsx");
    const ts = languageFor("component.ts");
    const tsx = languageFor("component.tsx");
    expect(js).not.toBe(ts);
    expect(ts).not.toBe(tsx);
    expect(await treeFor("component.jsx", "const value = <div/>;")).toContain("JSXElement");
    expect(await treeFor("component.ts", "const value: string = 'text';")).toContain("TypeAnnotation");
    const tree = await treeFor("component.tsx", "const value: unknown = <div/>;");
    expect(tree).toContain("TypeAnnotation");
    expect(tree).toContain("JSXElement");
    expect(yamlLoad.calls).toBe(0);
  });

  it.each([
    { name: "config.json", doc: '{"enabled":true}', node: "Object" },
    { name: "main.py", doc: "def greet():\n    return 'hello'\n", node: "FunctionDefinition" },
    { name: "main.rs", doc: "fn main() {}", node: "FunctionItem" },
    { name: "query.sql", doc: "SELECT id FROM users;", node: "Statement" },
    { name: "main.go", doc: "package main\nfunc main() {}", node: "Document" },
    { name: "main.ps1", doc: 'Write-Host "hello"', node: "Document" },
    { name: "main.java", doc: "class Main {}", node: "Document" },
    { name: "main.cs", doc: "class Main {}", node: "Document" },
    { name: "main.kt", doc: "fun main() {}", node: "Document" },
    { name: "main.rb", doc: "puts 'hello'", node: "Document" },
    { name: "main.lua", doc: "print('hello')", node: "Document" },
    { name: "config.toml", doc: '[project]\nname = "hello"', node: "Document" },
    { name: "main.swift", doc: 'print("hello")', node: "Document" },
    { name: "Dockerfile", doc: "FROM alpine\nRUN echo hello", node: "Document" },
    { name: "notes.md", doc: "# Hello", node: "ATXHeading1" },
  ])("builds a working CodeMirror state for $name", async ({ name, doc, node }) => {
    expect(await treeFor(name, doc)).toContain(node);
  });

  it("shares concurrent loads and keeps the resolved promise cached", async () => {
    const first = languageFor("config.yaml");
    const second = languageFor("other.yml");
    expect(second).toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(yamlLoad.calls).toBe(1);
    expect(languageFor("next.yaml")).toBe(first);
  });

  it("forgets a failed grammar so a later request retries without invalidating other grammars", async () => {
    const json = languageFor("config.json");
    await json;
    yamlLoad.fail = true;
    const first = languageFor("config.yaml");
    expect(languageFor("other.yml")).toBe(first);
    await expect(first).rejects.toThrow("grammar unavailable");
    yamlLoad.fail = false;
    const retry = languageFor("config.yaml");
    expect(retry).not.toBe(first);
    await expect(retry).resolves.not.toBeNull();
    expect(yamlLoad.calls).toBe(2);
    expect(languageFor("other.json")).toBe(json);
  });
});
