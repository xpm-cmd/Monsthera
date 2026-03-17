// Re-export classifyResultForLogging from its implementation in tools/runtime-instrumentation.
// This provides a clean import path from the logging layer for consumers like dashboard/server.ts.
export { classifyResultForLogging } from "../tools/runtime-instrumentation.js";
