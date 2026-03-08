import { z } from "zod/v4";
import { DEFAULT_AGORA_DIR, DEFAULT_DASHBOARD_PORT, DEFAULT_DB_NAME } from "./constants.js";

export const AgoraConfigSchema = z.object({
  repoPath: z.string(),
  agoraDir: z.string().default(DEFAULT_AGORA_DIR),
  dbName: z.string().default(DEFAULT_DB_NAME),
  dashboardPort: z.number().int().min(1024).max(65535).default(DEFAULT_DASHBOARD_PORT),
  verbosity: z.enum(["quiet", "normal", "verbose"]).default("normal"),
  debugLogging: z.boolean().default(false),
  coordinationTopology: z.enum(["hub-spoke", "hybrid", "mesh"]).default("hub-spoke"),
  sensitiveFilePatterns: z
    .array(z.string())
    .default([".env", ".env.*", "*.key", "*.pem", "credentials.*", "secrets.*"]),
  excludePatterns: z
    .array(z.string())
    .default([
      "*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.ico", "*.webp", "*.bmp", "*.tiff", "*.icns",
      "*.woff", "*.woff2", "*.ttf", "*.eot", "*.otf",
      "*.mp3", "*.mp4", "*.wav", "*.avi", "*.mov", "*.webm",
      "*.zip", "*.tar", "*.gz", "*.bz2", "*.7z", "*.rar",
      "*.pdf", "*.doc", "*.docx", "*.xls", "*.xlsx",
      "*.exe", "*.dll", "*.so", "*.dylib", "*.o", "*.a",
      "*.pyc", "*.pyo", "*.class", "*.jar", "*.wasm",
      "*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
      "*.min.js", "*.min.css", "*.map",
    ]),
  zoektEnabled: z.boolean().default(true),
  transport: z.enum(["stdio", "http"]).default("stdio"),
  httpPort: z.number().int().min(1024).max(65535).default(3000),
  noDashboard: z.boolean().default(false),
  semanticEnabled: z.boolean().default(false),
});

export type AgoraConfig = z.infer<typeof AgoraConfigSchema>;

export function resolveConfig(partial: Partial<AgoraConfig> & { repoPath: string }): AgoraConfig {
  return AgoraConfigSchema.parse(partial);
}
