#!/usr/bin/env node

/**
 * Download the semantic search model for offline use.
 *
 * Usage:
 *   node scripts/download-model.mjs
 *
 * This fetches `Xenova/all-MiniLM-L6-v2` (q8 quantized) via
 * @huggingface/transformers and copies the cached files into
 * `.monsthera/models/` so they ship with the npm package.
 *
 * Run this once with network access before `npm publish`.
 */

import { pipeline, env } from "@huggingface/transformers";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const modelsDir = resolve(projectRoot, ".monsthera", "models");

async function main() {
  console.log("Downloading model Xenova/all-MiniLM-L6-v2 (q8)...");

  // Let transformers.js download to its default cache first
  const pipe = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    dtype: "q8",
  });

  // Quick sanity check — embed a test string
  const out = await pipe("hello world", { pooling: "mean", normalize: true });
  console.log(`Model loaded OK — embedding dim: ${out.data.length}`);

  // Now copy from the cache into .monsthera/models/
  // transformers.js caches under env.cacheDir
  const cacheDir = env.cacheDir;
  if (!cacheDir) {
    console.error("Could not determine cache directory. Copy model files manually.");
    process.exit(1);
  }

  // The cache layout mirrors the HF Hub path:
  //   <cacheDir>/Xenova/all-MiniLM-L6-v2/...
  const cachedModelDir = resolve(cacheDir, "Xenova", "all-MiniLM-L6-v2");

  if (!existsSync(cachedModelDir)) {
    // Fallback: some versions use a flat hash-based layout.
    // In that case, point the user to copy manually.
    console.log(`Cache dir: ${cacheDir}`);
    console.log("Could not locate cached model files at expected path.");
    console.log("Please copy the model files manually into:");
    console.log(`  ${modelsDir}/Xenova/all-MiniLM-L6-v2/`);
    process.exit(1);
  }

  const destDir = resolve(modelsDir, "Xenova", "all-MiniLM-L6-v2");
  mkdirSync(destDir, { recursive: true });
  cpSync(cachedModelDir, destDir, { recursive: true });

  console.log(`Model files copied to ${destDir}`);
  console.log("You can now publish the package for offline use.");
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
