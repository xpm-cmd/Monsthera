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
name = "agora"
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
