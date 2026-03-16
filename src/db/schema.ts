import { sqliteTable, text, integer, real, blob, uniqueIndex, index } from "drizzle-orm/sqlite-core";

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

// --- Code Chunks ---

export const codeChunks = sqliteTable("code_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fileId: integer("file_id").notNull().references(() => files.id),
  chunkIndex: integer("chunk_index").notNull(),
  symbolName: text("symbol_name"),  // function/class name, null for module-level
  kind: text("kind"),  // "function", "class", "method", "module"
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  contentHash: text("content_hash"),
  embedding: blob("embedding"),  // same dimension as files.embedding
});

// --- Imports ---

export const imports = sqliteTable("imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceFileId: integer("source_file_id").notNull().references(() => files.id),
  targetPath: text("target_path").notNull(),
  kind: text("kind").notNull(), // "import", "require", "from"
});

// --- Symbol References ---

export const symbolReferences = sqliteTable("symbol_references", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceFileId: integer("source_file_id").notNull().references(() => files.id),
  sourceSymbolName: text("source_symbol_name"),  // enclosing function/class, null = module-level
  targetName: text("target_name").notNull(),      // called function/class/type name
  referenceKind: text("reference_kind").notNull(), // "call" | "member_call" | "type_ref"
  line: integer("line").notNull(),
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
  requiredRolesJson: text("required_roles_json"),
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
  supersededBy: integer("superseded_by"),
}, (table) => ({
  ticketSpecializationHistoryIdx: index("idx_review_verdicts_ticket_specialization_history")
    .on(table.ticketId, table.specialization, table.id),
}));

export const councilAssignments = sqliteTable("council_assignments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id),
  agentId: text("agent_id").notNull(),
  specialization: text("specialization").notNull(),
  assignedByAgentId: text("assigned_by_agent_id").notNull(),
  assignedAt: text("assigned_at").notNull(),
}, (table) => ({
  ticketSpecializationUniqueIdx: uniqueIndex("idx_council_assignments_ticket_specialization")
    .on(table.ticketId, table.specialization),
  ticketAgentIdx: index("idx_council_assignments_ticket_agent")
    .on(table.ticketId, table.agentId),
}));

// --- Ticket Dependencies ---

export const ticketDependencies = sqliteTable("ticket_dependencies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fromTicketId: integer("from_ticket_id").notNull().references(() => tickets.id),
  toTicketId: integer("to_ticket_id").notNull().references(() => tickets.id),
  relationType: text("relation_type").notNull(), // "blocks" | "relates_to"
  createdByAgentId: text("created_by_agent_id").notNull(),
  createdAt: text("created_at").notNull(),
});

// --- Work Groups ---

export const workGroups = sqliteTable("work_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id").notNull().references(() => repos.id),
  groupId: text("group_id").notNull().unique(),  // WG-{uuid8}
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("open"),  // "open" | "completed" | "cancelled"
  createdBy: text("created_by").notNull(),  // agentId
  tagsJson: text("tags_json"),  // JSON array
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  currentWave: integer("current_wave"),
  integrationBranch: text("integration_branch"),
  wavePlanJson: text("wave_plan_json"),
  launchedAt: text("launched_at"),
});

export const workGroupTickets = sqliteTable("work_group_tickets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workGroupId: integer("work_group_id").notNull().references(() => workGroups.id),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id),
  addedAt: text("added_at").notNull(),
  waveNumber: integer("wave_number"),
  waveStatus: text("wave_status").default("pending"),
}, (table) => ({
  uniqueGroupTicket: uniqueIndex("idx_work_group_tickets_unique")
    .on(table.workGroupId, table.ticketId),
}));

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
  worktreePath: text("worktree_path"),      // null for non-dev sessions
  worktreeBranch: text("worktree_branch"),   // null for non-dev sessions
});

// --- Job Slots (loop workforce management) ---

export const jobSlots = sqliteTable("job_slots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id").notNull().references(() => repos.id),
  slotId: text("slot_id").notNull().unique(),
  loopId: text("loop_id").notNull(),
  role: text("role").notNull(),
  specialization: text("specialization"),
  label: text("label").notNull(),
  description: text("description"),
  systemPrompt: text("system_prompt"),
  contextJson: text("context_json"),
  ticketId: text("ticket_id"),
  status: text("status").notNull().default("open"),
  agentId: text("agent_id"),
  sessionId: text("session_id"),
  claimedAt: text("claimed_at"),
  activeSince: text("active_since"),
  completedAt: text("completed_at"),
  lastHeartbeat: text("last_heartbeat"),
  progressNote: text("progress_note"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// --- Commit Locks (serializes merge-to-main across agents) ---

export const commitLocks = sqliteTable("commit_locks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  agentId: text("agent_id").notNull(),
  ticketId: text("ticket_id"),
  acquiredAt: text("acquired_at").notNull(),
  releasedAt: text("released_at"),
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
