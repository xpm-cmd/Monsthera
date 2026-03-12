import { sqliteTable, text, integer, real, blob } from "drizzle-orm/sqlite-core";

// --- Repository ---

export const repos = sqliteTable("repos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull().unique(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

// --- Index State ---

export const indexState = sqliteTable("index_state", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id").notNull().references(() => repos.id),
  dbIndexedCommit: text("db_indexed_commit"),
  zoektIndexedCommit: text("zoekt_indexed_commit"),
  indexedAt: text("indexed_at"),
  lastSuccess: text("last_success"),
  lastError: text("last_error"),
});

// --- Files ---

export const files = sqliteTable("files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id").notNull().references(() => repos.id),
  path: text("path").notNull(),
  language: text("language"),
  contentHash: text("content_hash"),
  summary: text("summary"),
  symbolsJson: text("symbols_json"), // JSON blob of SymbolInfo[]
  hasSecrets: integer("has_secrets", { mode: "boolean" }).default(false),
  secretLineRanges: text("secret_line_ranges"), // JSON blob
  indexedAt: text("indexed_at"),
  commitSha: text("commit_sha"),
  embedding: blob("embedding"),  // 384-dim float32 for semantic search, nullable
});

// --- Imports ---

export const imports = sqliteTable("imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceFileId: integer("source_file_id").notNull().references(() => files.id),
  targetPath: text("target_path").notNull(),
  kind: text("kind").notNull(), // "import", "require", "from"
});

// --- Notes ---

export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id").notNull().references(() => repos.id),
  type: text("type").notNull(), // NoteType enum
  key: text("key").notNull().unique(), // deterministic key
  content: text("content").notNull(),
  metadataJson: text("metadata_json"),
  linkedPathsJson: text("linked_paths_json"), // JSON array
  agentId: text("agent_id"),
  sessionId: text("session_id"),
  commitSha: text("commit_sha").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// --- Patches ---

export const patches = sqliteTable("patches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id").notNull().references(() => repos.id),
  proposalId: text("proposal_id").notNull().unique(),
  baseCommit: text("base_commit").notNull(), // invariant 2
  bundleId: text("bundle_id"), // provenance
  state: text("state").notNull(), // PatchState enum
  diff: text("diff").notNull(),
  message: text("message").notNull(),
  touchedPathsJson: text("touched_paths_json"),
  dryRunResultJson: text("dry_run_result_json"),
  agentId: text("agent_id").notNull(),
  sessionId: text("session_id").notNull(),
  committedSha: text("committed_sha"),
  ticketId: integer("ticket_id").references(() => tickets.id),  // physical FK for new installs, app-level for migrated
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// --- Tickets ---

export const tickets = sqliteTable("tickets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id").notNull().references(() => repos.id),
  ticketId: text("ticket_id").notNull().unique(),  // TKT-{uuid8}
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull().default("backlog"),
  severity: text("severity").notNull().default("medium"),
  priority: integer("priority").notNull().default(5),
  tagsJson: text("tags_json"),
  affectedPathsJson: text("affected_paths_json"),
  acceptanceCriteria: text("acceptance_criteria"),
  creatorAgentId: text("creator_agent_id").notNull(),
  creatorSessionId: text("creator_session_id").notNull(),
  assigneeAgentId: text("assignee_agent_id"),
  resolvedByAgentId: text("resolved_by_agent_id"),
  commitSha: text("commit_sha").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const ticketHistory = sqliteTable("ticket_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  agentId: text("agent_id").notNull(),
  sessionId: text("session_id").notNull(),
  comment: text("comment"),
  timestamp: text("timestamp").notNull(),
});

export const ticketComments = sqliteTable("ticket_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id),
  agentId: text("agent_id").notNull(),
  sessionId: text("session_id").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
});

export const reviewVerdicts = sqliteTable("review_verdicts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id),
  agentId: text("agent_id").notNull(),
  sessionId: text("session_id").notNull(),
  specialization: text("specialization").notNull(),
  verdict: text("verdict").notNull(),
  reasoning: text("reasoning"),
  createdAt: text("created_at").notNull(),
});

// --- Ticket Dependencies ---

export const ticketDependencies = sqliteTable("ticket_dependencies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fromTicketId: integer("from_ticket_id").notNull().references(() => tickets.id),
  toTicketId: integer("to_ticket_id").notNull().references(() => tickets.id),
  relationType: text("relation_type").notNull(), // "blocks" | "relates_to"
  createdByAgentId: text("created_by_agent_id").notNull(),
  createdAt: text("created_at").notNull(),
});

// --- Coordination Messages ---

export const coordinationMessages = sqliteTable("coordination_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id").notNull().references(() => repos.id),
  messageId: text("message_id").notNull().unique(),
  fromAgentId: text("from_agent_id").notNull(),
  toAgentId: text("to_agent_id"),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  timestamp: text("timestamp").notNull(),
});

// --- Dashboard Events ---

export const dashboardEvents = sqliteTable("dashboard_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id").notNull().references(() => repos.id),
  eventType: text("event_type").notNull(),
  dataJson: text("data_json").notNull(),
  timestamp: text("timestamp").notNull(),
});

// --- Agents ---

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull().default("unknown"),
  provider: text("provider"),
  model: text("model"),
  modelFamily: text("model_family"),
  modelVersion: text("model_version"),
  identitySource: text("identity_source"),
  roleId: text("role_id").notNull().default("observer"),
  trustTier: text("trust_tier").notNull().default("B"),
  registeredAt: text("registered_at").notNull(),
});

// --- Roles (for custom roles; built-in roles are in code) ---

export const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  permissionsJson: text("permissions_json").notNull(), // JSON of RolePermissions
  isBuiltIn: integer("is_built_in", { mode: "boolean" }).default(false),
  createdAt: text("created_at").notNull(),
});

// --- Sessions ---

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  state: text("state").notNull().default("active"),
  connectedAt: text("connected_at").notNull(),
  lastActivity: text("last_activity").notNull(),
  claimedFilesJson: text("claimed_files_json"), // JSON array
});

// --- Event Logs (metadata-only by default) ---

export const eventLogs = sqliteTable("event_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull().unique(),
  agentId: text("agent_id").notNull(),
  sessionId: text("session_id").notNull(),
  tool: text("tool").notNull(),
  timestamp: text("timestamp").notNull(),
  durationMs: real("duration_ms").notNull(),
  status: text("status").notNull(), // EventStatus enum
  repoId: text("repo_id").notNull(),
  commitScope: text("commit_scope").notNull(),
  payloadSizeIn: integer("payload_size_in").notNull(),
  payloadSizeOut: integer("payload_size_out").notNull(),
  inputHash: text("input_hash").notNull(),
  outputHash: text("output_hash").notNull(),
  redactedSummary: text("redacted_summary").notNull(),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  denialReason: text("denial_reason"),
});

// --- Knowledge ---

export const knowledge = sqliteTable("knowledge", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  type: text("type").notNull(),
  scope: text("scope").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  tagsJson: text("tags_json"),
  status: text("status").notNull().default("active"),
  agentId: text("agent_id"),
  sessionId: text("session_id"),
  embedding: blob("embedding"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// --- Protected Artifacts ---

export const protectedArtifacts = sqliteTable("protected_artifacts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id").notNull().references(() => repos.id),
  pathPattern: text("path_pattern").notNull(),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
});

// --- Debug Payloads (only when --debug-logging is enabled, 24h TTL) ---

export const debugPayloads = sqliteTable("debug_payloads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull().references(() => eventLogs.eventId),
  rawInput: text("raw_input"), // redacted for secrets
  rawOutput: text("raw_output"), // redacted for secrets
  expiresAt: text("expires_at").notNull(),
});
