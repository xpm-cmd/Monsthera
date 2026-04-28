import { describe, it } from "vitest";

/**
 * M3 placeholder tests — see ADR-017 D7 for the fixture strategy. Each
 * `it.skip` below names the per-language fixture file that the
 * implementation PR will materialize under
 * `tests/fixtures/code-intelligence/m3/`. Once the TextMate-backed
 * extractor lands, these placeholders are unskipped one-by-one against
 * the corresponding fixtures.
 */
describe("SymbolExtractor (M3 scaffold)", () => {
  it.skip("extracts function/class/interface/type/enum from typescript.fix.ts", () => {
    // TODO(M3): load tests/fixtures/code-intelligence/m3/typescript.fix.ts,
    // run the TextMate extractor, assert the expected symbol set.
  });

  it.skip("extracts def/class/decorator from python.fix.py", () => {
    // TODO(M3)
  });

  it.skip("extracts func/method/type/struct/interface from go.fix.go", () => {
    // TODO(M3)
  });

  it.skip("extracts fn/struct/enum/trait/impl from rust.fix.rs", () => {
    // TODO(M3)
  });

  it.skip("emits file-level entry only for unknown.fix.xyz", () => {
    // TODO(M3): verify the degraded path documented in ADR-017 D3.
  });

  it.skip("never throws on pathological input — returns [] and logs at debug", () => {
    // TODO(M3): confirm the no-throw contract from src/code-intelligence/inventory/extractor.ts.
  });
});
