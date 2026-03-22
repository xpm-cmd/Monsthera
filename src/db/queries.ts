// Barrel re-export: all domain-scoped query modules.
// Maintains 100% backward compatibility — all 53 files using
// `import * as queries from "../db/queries.js"` continue working.
export * from "./queries/common.js";
export * from "./queries/files-indexing.js";
export * from "./queries/notes.js";
export * from "./queries/patches.js";
export * from "./queries/knowledge.js";
export * from "./queries/coordination.js";
export * from "./queries/events.js";
export * from "./queries/artifacts.js";
export * from "./queries/agents-sessions.js";
export * from "./queries/jobs.js";
export * from "./queries/tickets.js";
export * from "./queries/work-groups.js";
