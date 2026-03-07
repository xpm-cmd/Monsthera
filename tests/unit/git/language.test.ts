import { describe, it, expect } from "vitest";
import { detectLanguage, isSupported, isSupportedLanguage } from "../../../src/git/language.js";

describe("detectLanguage", () => {
  it("detects TypeScript files", () => {
    expect(detectLanguage("src/index.ts")).toBe("typescript");
    expect(detectLanguage("Component.tsx")).toBe("typescript");
    expect(detectLanguage("lib.mts")).toBe("typescript");
    expect(detectLanguage("config.cts")).toBe("typescript");
  });

  it("detects JavaScript files", () => {
    expect(detectLanguage("index.js")).toBe("javascript");
    expect(detectLanguage("app.jsx")).toBe("javascript");
    expect(detectLanguage("module.mjs")).toBe("javascript");
    expect(detectLanguage("legacy.cjs")).toBe("javascript");
  });

  it("detects Python files", () => {
    expect(detectLanguage("main.py")).toBe("python");
    expect(detectLanguage("gui.pyw")).toBe("python");
  });

  it("returns null for unsupported files", () => {
    expect(detectLanguage("README.md")).toBeNull();
    expect(detectLanguage("Makefile")).toBeNull();
    expect(detectLanguage("style.css")).toBeNull();
    expect(detectLanguage("data.json")).toBeNull();
  });
});

describe("isSupported", () => {
  it("returns true for supported extensions", () => {
    expect(isSupported("index.ts")).toBe(true);
    expect(isSupported("main.py")).toBe(true);
  });

  it("returns false for unsupported extensions", () => {
    expect(isSupported("README.md")).toBe(false);
  });
});

describe("isSupportedLanguage", () => {
  it("returns true for supported language strings", () => {
    expect(isSupportedLanguage("typescript")).toBe(true);
    expect(isSupportedLanguage("javascript")).toBe(true);
    expect(isSupportedLanguage("python")).toBe(true);
  });

  it("returns false for unsupported language strings", () => {
    expect(isSupportedLanguage("rust")).toBe(false);
    expect(isSupportedLanguage("go")).toBe(false);
  });
});
