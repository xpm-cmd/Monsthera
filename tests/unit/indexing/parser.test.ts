import { describe, it, expect } from "vitest";
import { parseFile } from "../../../src/indexing/parser.js";

describe("parseFile - TypeScript", () => {
  it("extracts function declarations", async () => {
    const content = `
export function greet(name: string): string {
  return "hello " + name;
}

function helper() {
  return 42;
}
`;
    const result = await parseFile(content, "typescript");
    const fns = result.symbols.filter((s) => s.kind === "function");
    expect(fns.map((f) => f.name)).toContain("greet");
    expect(fns.map((f) => f.name)).toContain("helper");
  });

  it("extracts class and method declarations", async () => {
    const content = `
class MyService {
  constructor() {}
  getData() { return []; }
  processItem(item: string) { return item; }
}
`;
    const result = await parseFile(content, "typescript");
    expect(result.symbols.some((s) => s.kind === "class" && s.name === "MyService")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "method" && s.name === "getData")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "method" && s.name === "processItem")).toBe(true);
  });

  it("extracts type and interface declarations", async () => {
    const content = `
type UserId = string;
interface Config {
  port: number;
  host: string;
}
`;
    const result = await parseFile(content, "typescript");
    const types = result.symbols.filter((s) => s.kind === "type");
    expect(types.map((t) => t.name)).toContain("UserId");
    expect(types.map((t) => t.name)).toContain("Config");
  });

  it("extracts top-level variable declarations", async () => {
    const content = `
const VERSION = "1.0.0";
let counter = 0;
`;
    const result = await parseFile(content, "typescript");
    expect(result.symbols.some((s) => s.kind === "variable" && s.name === "VERSION")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "variable" && s.name === "counter")).toBe(true);
  });

  it("extracts bound identifiers from top-level destructuring declarations", async () => {
    const content = `
const {
  ftsSearchMock,
  ftsInitMock: initMock,
  nested: { rebuildMock },
  ...restMocks
} = mocks;
`;
    const result = await parseFile(content, "typescript");
    const variableNames = result.symbols
      .filter((s) => s.kind === "variable")
      .map((s) => s.name);

    expect(variableNames).toContain("ftsSearchMock");
    expect(variableNames).toContain("initMock");
    expect(variableNames).toContain("rebuildMock");
    expect(variableNames).toContain("restMocks");
    expect(variableNames.some((name) => name.includes("{"))).toBe(false);
  });

  it("extracts import statements", async () => {
    const content = `
import { readFile } from "node:fs";
import path from "node:path";
`;
    const result = await parseFile(content, "typescript");
    expect(result.imports.some((i) => i.source === "node:fs" && i.kind === "import")).toBe(true);
    expect(result.imports.some((i) => i.source === "node:path" && i.kind === "import")).toBe(true);
  });

  it("counts lines correctly", async () => {
    const content = "line1\nline2\nline3\n";
    const result = await parseFile(content, "typescript");
    expect(result.lineCount).toBe(4); // trailing newline = extra empty line
  });
});

describe("parseFile - JavaScript", () => {
  it("extracts functions and variables", async () => {
    const content = `
function add(a, b) { return a + b; }
const PI = 3.14;
`;
    const result = await parseFile(content, "javascript");
    expect(result.symbols.some((s) => s.kind === "function" && s.name === "add")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "variable" && s.name === "PI")).toBe(true);
  });

  it("extracts require imports", async () => {
    const content = `const fs = require("node:fs");`;
    const result = await parseFile(content, "javascript");
    expect(result.imports.some((i) => i.source === "node:fs" && i.kind === "require")).toBe(true);
  });
});

describe("parseFile - Python", () => {
  it("extracts function definitions", async () => {
    const content = `
def greet(name):
    return f"hello {name}"

def compute(x, y):
    return x + y
`;
    const result = await parseFile(content, "python");
    const fns = result.symbols.filter((s) => s.kind === "function");
    expect(fns.map((f) => f.name)).toContain("greet");
    expect(fns.map((f) => f.name)).toContain("compute");
  });

  it("extracts class and method definitions", async () => {
    const content = `
class Animal:
    def __init__(self, name):
        self.name = name

    def speak(self):
        pass
`;
    const result = await parseFile(content, "python");
    expect(result.symbols.some((s) => s.kind === "class" && s.name === "Animal")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "method" && s.name === "__init__")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "method" && s.name === "speak")).toBe(true);
  });

  it("extracts top-level variable assignments", async () => {
    const content = `
MAX_SIZE = 100
name = "monsthera"
`;
    const result = await parseFile(content, "python");
    expect(result.symbols.some((s) => s.kind === "variable" && s.name === "MAX_SIZE")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "variable" && s.name === "name")).toBe(true);
  });

  it("extracts import statements", async () => {
    const content = `
import os
from pathlib import Path
`;
    const result = await parseFile(content, "python");
    expect(result.imports.some((i) => i.source === "os" && i.kind === "import")).toBe(true);
  });
});

describe("parseFile - Go", () => {
  it("extracts function declarations", async () => {
    const content = `package main

func main() {
	fmt.Println("hello")
}

func add(a, b int) int {
	return a + b
}
`;
    const result = await parseFile(content, "go");
    const fns = result.symbols.filter((s) => s.kind === "function");
    expect(fns.map((f) => f.name)).toContain("main");
    expect(fns.map((f) => f.name)).toContain("add");
  });

  it("extracts struct and interface types", async () => {
    const content = `package main

type Server struct {
	Host string
	Port int
}

type Handler interface {
	Handle() error
}
`;
    const result = await parseFile(content, "go");
    expect(result.symbols.some((s) => s.kind === "class" && s.name === "Server")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "class" && s.name === "Handler")).toBe(true);
  });

  it("extracts method declarations", async () => {
    const content = `package main

func (s *Server) Start() error {
	return nil
}
`;
    const result = await parseFile(content, "go");
    expect(result.symbols.some((s) => s.kind === "method" && s.name === "Start")).toBe(true);
  });

  it("extracts imports", async () => {
    const content = `package main

import (
	"fmt"
	"net/http"
)
`;
    const result = await parseFile(content, "go");
    expect(result.imports.some((i) => i.source === "fmt")).toBe(true);
    expect(result.imports.some((i) => i.source === "net/http")).toBe(true);
  });

  it("extracts const and var declarations", async () => {
    const content = `package main

const MaxSize = 100
var counter int
`;
    const result = await parseFile(content, "go");
    expect(result.symbols.some((s) => s.kind === "variable" && s.name === "MaxSize")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "variable" && s.name === "counter")).toBe(true);
  });
});

describe("parseFile - Rust", () => {
  it("extracts function declarations", async () => {
    const content = `fn main() {
    println!("hello");
}

fn add(a: i32, b: i32) -> i32 {
    a + b
}
`;
    const result = await parseFile(content, "rust");
    const fns = result.symbols.filter((s) => s.kind === "function");
    expect(fns.map((f) => f.name)).toContain("main");
    expect(fns.map((f) => f.name)).toContain("add");
  });

  it("extracts struct and enum declarations", async () => {
    const content = `struct Server {
    host: String,
    port: u16,
}

enum Status {
    Active,
    Inactive,
}
`;
    const result = await parseFile(content, "rust");
    expect(result.symbols.some((s) => s.kind === "class" && s.name === "Server")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "type" && s.name === "Status")).toBe(true);
  });

  it("extracts trait and type alias", async () => {
    const content = `trait Handler {
    fn handle(&self) -> Result<(), Error>;
}

type UserId = u64;
`;
    const result = await parseFile(content, "rust");
    expect(result.symbols.some((s) => s.kind === "type" && s.name === "Handler")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "type" && s.name === "UserId")).toBe(true);
  });

  it("extracts impl methods", async () => {
    const content = `struct Server {}

impl Server {
    fn new() -> Self {
        Server {}
    }

    fn start(&self) {}
}
`;
    const result = await parseFile(content, "rust");
    expect(result.symbols.some((s) => s.kind === "class" && s.name === "Server")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "method" && s.name === "new")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "method" && s.name === "start")).toBe(true);
  });

  it("extracts use declarations", async () => {
    const content = `use std::collections::HashMap;
use std::io;
`;
    const result = await parseFile(content, "rust");
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
    expect(result.imports.some((i) => i.source.includes("HashMap"))).toBe(true);
    expect(result.imports.some((i) => i.source.includes("io"))).toBe(true);
  });

  it("extracts const and static declarations", async () => {
    const content = `const MAX_SIZE: usize = 100;
static COUNTER: i32 = 0;
`;
    const result = await parseFile(content, "rust");
    expect(result.symbols.some((s) => s.kind === "variable" && s.name === "MAX_SIZE")).toBe(true);
    expect(result.symbols.some((s) => s.kind === "variable" && s.name === "COUNTER")).toBe(true);
  });
});

// --- Reference extraction ---

describe("parseFile - Python references", () => {
  it("extracts direct function calls", async () => {
    const content = `
def main():
    result = compute(42)
    print(result)
`;
    const result = await parseFile(content, "python");
    expect(result.references.some((r) => r.kind === "call" && r.targetName === "compute" && r.sourceSymbol === "main")).toBe(true);
    expect(result.references.some((r) => r.kind === "call" && r.targetName === "print" && r.sourceSymbol === "main")).toBe(true);
  });

  it("extracts member calls (attribute access)", async () => {
    const content = `
def process():
    items = []
    items.append(1)
    result = db.query("SELECT 1")
`;
    const result = await parseFile(content, "python");
    expect(result.references.some((r) => r.kind === "member_call" && r.targetName === "append")).toBe(true);
    expect(result.references.some((r) => r.kind === "member_call" && r.targetName === "query")).toBe(true);
  });

  it("extracts class inheritance as type_ref", async () => {
    const content = `
class Dog(Animal, Serializable):
    pass
`;
    const result = await parseFile(content, "python");
    expect(result.references.some((r) => r.kind === "type_ref" && r.targetName === "Animal")).toBe(true);
    expect(result.references.some((r) => r.kind === "type_ref" && r.targetName === "Serializable")).toBe(true);
  });

  it("tracks enclosing symbol — null for module-level calls", async () => {
    const content = `
setup()

def main():
    run()
`;
    const result = await parseFile(content, "python");
    expect(result.references.some((r) => r.targetName === "setup" && r.sourceSymbol === null)).toBe(true);
    expect(result.references.some((r) => r.targetName === "run" && r.sourceSymbol === "main")).toBe(true);
  });

  it("extracts type annotations as type_ref", async () => {
    const content = `
def greet(name: str) -> str:
    return name
`;
    const result = await parseFile(content, "python");
    expect(result.references.some((r) => r.kind === "type_ref")).toBe(true);
  });
});

describe("parseFile - Go references", () => {
  it("extracts direct function calls", async () => {
    const content = `package main

func main() {
	result := compute(42)
}
`;
    const result = await parseFile(content, "go");
    expect(result.references.some((r) => r.kind === "call" && r.targetName === "compute" && r.sourceSymbol === "main")).toBe(true);
  });

  it("extracts selector (method) calls", async () => {
    const content = `package main

func handler(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("ok"))
	r.ParseForm()
}
`;
    const result = await parseFile(content, "go");
    expect(result.references.some((r) => r.kind === "member_call" && r.targetName === "Write")).toBe(true);
    expect(result.references.some((r) => r.kind === "member_call" && r.targetName === "ParseForm")).toBe(true);
  });

  it("extracts type_identifier references", async () => {
    const content = `package main

func newServer(cfg Config) *Server {
	return &Server{}
}
`;
    const result = await parseFile(content, "go");
    expect(result.references.some((r) => r.kind === "type_ref" && r.targetName === "Config")).toBe(true);
    expect(result.references.some((r) => r.kind === "type_ref" && r.targetName === "Server")).toBe(true);
  });

  it("skips type_identifier in type definitions", async () => {
    const content = `package main

type Server struct {
	Host string
}
`;
    const result = await parseFile(content, "go");
    // "Server" is a definition, not a reference — should not appear as type_ref
    const serverRefs = result.references.filter((r) => r.targetName === "Server" && r.kind === "type_ref");
    expect(serverRefs).toHaveLength(0);
  });

  it("tracks enclosing symbol for method declarations", async () => {
    const content = `package main

func (s *Server) Start() error {
	listen()
	return nil
}
`;
    const result = await parseFile(content, "go");
    expect(result.references.some((r) => r.targetName === "listen" && r.sourceSymbol === "Start")).toBe(true);
  });
});

describe("parseFile - Rust references", () => {
  it("extracts direct function calls", async () => {
    const content = `fn main() {
    let x = compute(42);
}
`;
    const result = await parseFile(content, "rust");
    expect(result.references.some((r) => r.kind === "call" && r.targetName === "compute" && r.sourceSymbol === "main")).toBe(true);
  });

  it("extracts scoped calls like Vec::new", async () => {
    const content = `fn build() {
    let v = Vec::new();
    let m = HashMap::with_capacity(10);
}
`;
    const result = await parseFile(content, "rust");
    expect(result.references.some((r) => r.kind === "call" && r.targetName === "new")).toBe(true);
    expect(result.references.some((r) => r.kind === "call" && r.targetName === "with_capacity")).toBe(true);
  });

  it("extracts method calls", async () => {
    const content = `fn process() {
    let mut items = Vec::new();
    items.push(1);
    items.iter().map(|x| x + 1);
}
`;
    const result = await parseFile(content, "rust");
    expect(result.references.some((r) => r.kind === "member_call" && r.targetName === "push")).toBe(true);
  });

  it("extracts type references from function signatures", async () => {
    const content = `fn serve(config: Config) -> Result<Server, Error> {
    todo!()
}
`;
    const result = await parseFile(content, "rust");
    expect(result.references.some((r) => r.kind === "type_ref" && r.targetName === "Config")).toBe(true);
    expect(result.references.some((r) => r.kind === "type_ref" && r.targetName === "Result")).toBe(true);
  });

  it("extracts impl type and trait references", async () => {
    const content = `impl Handler for Server {
    fn handle(&self) {}
}
`;
    const result = await parseFile(content, "rust");
    expect(result.references.some((r) => r.kind === "type_ref" && r.targetName === "Handler")).toBe(true);
    expect(result.references.some((r) => r.kind === "type_ref" && r.targetName === "Server")).toBe(true);
  });

  it("skips type_identifier in definition nodes", async () => {
    const content = `struct Config {
    port: u16,
}
`;
    const result = await parseFile(content, "rust");
    // "Config" is a definition, not a reference
    const configRefs = result.references.filter((r) => r.targetName === "Config" && r.kind === "type_ref");
    expect(configRefs).toHaveLength(0);
  });
});

// --- Leading comment extraction (Nivel 2) ---

describe("parseFile — leadingComment extraction", () => {
  it("extracts TS/JS block comment at file start", async () => {
    const content = `/**
 * This module handles authentication and session management.
 * It provides JWT-based auth with refresh tokens.
 */
import { sign } from "jsonwebtoken";

export function authenticate() {}
`;
    const result = await parseFile(content, "typescript");
    expect(result.leadingComment).toContain("This module handles authentication and session management");
    expect(result.leadingComment).toContain("JWT-based auth");
  });

  it("extracts TS/JS single-line comments at file start", async () => {
    const content = `// Search router — routes queries to FTS5 or Zoekt
// Falls back gracefully if primary backend is unavailable

import { FTS5Backend } from "./fts5.js";
`;
    const result = await parseFile(content, "typescript");
    expect(result.leadingComment).toContain("Search router");
    expect(result.leadingComment).toContain("Falls back gracefully");
  });

  it("returns empty string when no leading comment exists", async () => {
    const content = `import { readFile } from "node:fs";
export function main() {}
`;
    const result = await parseFile(content, "typescript");
    expect(result.leadingComment).toBe("");
  });

  it("extracts Python module docstring", async () => {
    const content = `"""
Trust enforcement module.
Validates agent permissions against role-based access control.
"""

import os
from pathlib import Path

def check_trust(agent_id):
    pass
`;
    const result = await parseFile(content, "python");
    expect(result.leadingComment).toContain("Trust enforcement module");
    expect(result.leadingComment).toContain("role-based access control");
  });

  it("handles Python file without docstring", async () => {
    const content = `import os

def main():
    pass
`;
    const result = await parseFile(content, "python");
    expect(result.leadingComment).toBe("");
  });

  it("extracts Go leading comment", async () => {
    const content = `// Package server implements the HTTP and MCP server.
// It provides endpoints for search, indexing, and coordination.
package main

import "fmt"
`;
    const result = await parseFile(content, "go");
    expect(result.leadingComment).toContain("Package server");
    expect(result.leadingComment).toContain("search, indexing, and coordination");
  });

  it("extracts Rust doc comments", async () => {
    const content = `//! Evidence bundle builder.
//! Creates deterministic, cacheable search result bundles.

use std::collections::HashMap;

fn build() {}
`;
    const result = await parseFile(content, "rust");
    expect(result.leadingComment).toContain("Evidence bundle builder");
    expect(result.leadingComment).toContain("deterministic");
  });
});
