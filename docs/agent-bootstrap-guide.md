# Agent bootstrap guide — Claude Code & Codex CLI

**Audience:** anyone using Monsthera as an MCP server / CLI from their AI coding agent (Claude Code, Codex CLI, Codex desktop). This is an **optional** UX layer on top of [`consumer-setup.md`](consumer-setup.md). It does not change how Monsthera works — it just makes your agent aware of the project state at session start so the first turns aren't spent diagnosing missing dependencies or version drift.

If you are still wiring Monsthera itself, read [`consumer-setup.md`](consumer-setup.md) first. Come back here once `monsthera --version` works from your shell.

---

## What this gives you

A single bash helper script that runs once per agent session in any Monsthera-related repository (the Monsthera repo itself, a worktree of it, or any consumer repo that depends on it). Two independent layers run in sequence:

**Environmental bootstrap (Phases A–D)** — verifies the toolchain works:

1. **Detects scope** — exits silently in <50 ms when the current directory is not Monsthera-related, so unrelated projects pay nothing.
2. **Auto-fixes one specific thing** — runs `pnpm install --prefer-offline` when `node_modules/` is missing (idempotent, ~10 s on a cold cache, ~1 s when not needed). Nothing else is auto-fixed.
3. **Diagnoses state** — version drift between the global `monsthera` binary and the consumer repo's `package.json`, managed Dolt process state, whether the M3 code inventory has been built, and whether `monsthera self update --dry-run` reports blockers.
4. **Smart-output** — emits a `## Monsthera bootstrap` markdown block **only when something is actionable**. Healthy sessions produce zero output and zero token cost.

**Cognitive briefing (Phase E)** — bridges agent sessions:

5. **Opens a Monsthera session** for the detected agent (`claude-code` / `codex-cli` / configurable). The session record is persisted under `<repo>/knowledge/sessions/`.
6. **Emits a `## Monsthera briefing` block** with a short teaser pointing at the previous session's handoff article — the agent picks up where the last session left off, with verifiable citations to events/work/knowledge/code. Skipped silently if no previous session exists (just creates a fresh one).
7. **Surfaces orphan warnings** when the previous session's async handoff worker did not finish writing — the next agent sees `⚠ Previous handoff is incomplete` and a one-line recovery command.

Phase E reuses the same hook plumbing and the same 5 s timeout / never-blocks contract as Phases A–D. The cost is one extra `monsthera` CLI call per session start (typically <200 ms). The agent's responsibility on the way out is a single `monsthera session close [--note "..."]` call — see [Step 5](#step-5--agent-responsibility-on-the-way-out).

The same script reaches three integration points:

| Agent | Mechanism | Coverage |
|---|---|---|
| **Claude Code** | `SessionStart` hook in `~/.claude/settings.json` | every session start, deterministic |
| **Codex CLI** (terminal) | `codex()` shell function in `~/.zshrc` / `~/.bashrc` | every `codex` invocation from a shell, deterministic |
| **Codex desktop / agent** | `~/.codex/AGENTS.md` mention | non-deterministic safety net (the agent learns the script exists and can invoke it on suspicion) |

---

## Design decisions (summary)

The script's design is locked by six trade-offs. You can adjust them — see [Customization](#customization).

| # | Decision | Default | Alternative if your needs differ |
|---|---|---|---|
| 1 | **Scope** | Detects Monsthera-related repos via three OR'd checks: `.monsthera/` directory present, or `package.json` mentions `"monsthera"`, or repo has `src/bin.ts` and `"name": "monsthera"`. | If you want a single repo only, replace the detection with a hardcoded path equality check. |
| 2 | **Diagnostic depth** | Medium: version drift, Dolt running, code inventory built, update blockers. Skips the slow `monsthera doctor` (5-10 s). | For richer info (Ollama embedding health, search index state), call `monsthera doctor` instead, but expect ~5-10 s on every session. |
| 3 | **Failure mode** | Conservative: only `pnpm install --prefer-offline` is auto-run. Everything else surfaces as a hint for the agent or human to act on. | If you want to auto-run `monsthera self update` or `code reindex`, you can extend Phase C. Be aware these can block sessions on first run. |
| 4 | **Packaging** | External bash script invoked by a one-line command in each integration point. | A native `monsthera self bootstrap` subcommand could replace this, but creates chicken-and-egg coupling (the binary is what we're checking). Bash stays portable and dependency-free. |
| 5 | **Codex integration** | Both shell function (CLI deterministic) and AGENTS.md (desktop safety net). Same script powers both. | If you only use Codex CLI, skip the AGENTS.md step. If you only use the desktop app, skip the shell function. |
| 6 | **Cognitive layer** | Phase E opens a Monsthera session and emits a `## Monsthera briefing` teaser. The previous session's handoff article (LLM-generated by a local Ollama model) is the source of truth. | Set `MONSTHERA_SESSIONS_LLM_ENABLED=false` to disable LLM stages — sessions still track lifecycle, but handoff articles become T1-only (metadata + Hypergraph, no narrative). Or skip the briefing entirely by removing Phase E from the script. |

For the full rationale (including alternatives considered and rejected), see the [original design spec](#further-reading).

---

## Components — what the script does

Five phases, executed sequentially:

**Phase A — Scope detection.** Three OR'd checks. If none match, `exit 0` silent (~5-20 ms).

**Phase B — State capture (read-only, ~200 ms-2 s).** Calls `monsthera --version`, reads `package.json` version, checks for `node_modules/`, runs `monsthera self status --json` (capped at 2 s, parsed for `processes.dolt.running`), runs `monsthera status --json` (capped at 2 s, parsed for `stats.codeInventory.built`), and only when versions diverge runs `monsthera self update --dry-run` to detect blockers.

**Phase C — Conservative auto-fix.** If `package.json` exists and `node_modules/` does not, runs `pnpm install --prefer-offline`. Records success/failure for the output stage.

**Phase D — Smart-output (environmental).** Collects findings/warnings/hints into three arrays. Emits a single markdown block under `## Monsthera bootstrap` heading (severity-ordered) **only if any array is non-empty**. Healthy environments produce no output.

**Phase E — Cognitive briefing (~100-200 ms).** Detects the AI agent (`MONSTHERA_AGENT_ID` override, then `CLAUDE_*` / `CODEX_*` env), calls `monsthera session open --teaser-only` which creates a session record and emits a short teaser. The teaser contains: the previous session's id + close time, a pointer to its handoff article, and — when the previous session's async worker did not finish — a `⚠ Previous handoff is incomplete` warning with a recovery command. Emitted under `## Monsthera briefing`. Skipped silently if the agent is unknown or the CLI is too old to support the `session` subcommand.

Hard rules:

- `set +e` and `trap 'exit 0' EXIT` — the script never aborts the session, even on internal bugs.
- `stdout` is the agent context; `stderr` is debug only.
- Inner timeouts (2 s on each Phase B CLI call, 5 s on the Phase E `session open` call) use a portable bash helper that prefers `gtimeout`/`timeout` and falls back to a background+watchdog pattern. Outer timeout (30 s for the whole script) is enforced by the caller (the hook command).
- Auth tokens (`Bearer ...`, `npm_...`, `ghp_...`, `glpat-...`, AWS access keys) are redacted from any captured `pnpm install` log before being shown to the agent.
- `MONSTHERA_BOOTSTRAP_DEBUG=1` enables `set -x` and writes the trace to `/tmp/monsthera-bootstrap.debug.log`. For Phase E specifically, `MONSTHERA_SESSIONS_WORKER_LOG=/tmp/monsthera-worker.log` redirects the async handoff worker's stdio to that file.

---

## Step 1 — Install the script

Save the file below as `~/.claude/scripts/monsthera-bootstrap.sh` and `chmod +x` it. The path is conventional; if you prefer somewhere else, adjust the references in the integration steps below.

```bash
#!/usr/bin/env bash
# Monsthera bootstrap — single source of truth for Claude Code SessionStart and
# Codex shell-function pre-launch.
#
# Hard rules:
#   - exit 0 ALWAYS, even on internal bugs (trap below).
#   - stdout = agent context; stderr = debug only.
#   - 30-second outer timeout enforced by the caller (hook wrapper); the
#     script itself caps `monsthera self status` at 2s with a portable helper.

set +e
trap 'exit 0' EXIT

if [[ "${MONSTHERA_BOOTSTRAP_DEBUG:-}" == "1" ]]; then
  set -x
  exec 2>>"/tmp/monsthera-bootstrap.debug.log"
fi

# CLAUDE_PROJECT_DIR fallback (manual runs, older Claude Code, Codex shell)
CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"

# ----- Portable timeout helper --------------------------------------------------
# macOS does not ship `timeout`. If GNU coreutils is installed, prefer
# `gtimeout`/`timeout`. Otherwise fall back to a background job with a
# watchdog kill — works in any POSIX bash.
if command -v gtimeout >/dev/null 2>&1; then
  _timeout() { gtimeout "$@"; }
elif command -v timeout >/dev/null 2>&1; then
  _timeout() { command timeout "$@"; }
else
  _timeout() {
    local secs="$1"; shift
    "$@" &
    local pid=$!
    ( sleep "$secs" && kill -TERM "$pid" 2>/dev/null ) &
    local watcher=$!
    wait "$pid" 2>/dev/null
    local rc=$?
    kill "$watcher" 2>/dev/null
    return "$rc"
  }
fi

# ----- Phase A — Scope detection ------------------------------------------------
in_scope=0
[[ -d "$CLAUDE_PROJECT_DIR/.monsthera" ]] && in_scope=1
if [[ "$in_scope" -eq 0 && -f "$CLAUDE_PROJECT_DIR/package.json" ]]; then
  grep -q '"monsthera"' "$CLAUDE_PROJECT_DIR/package.json" 2>/dev/null && in_scope=1
fi
if [[ "$in_scope" -eq 0 && -f "$CLAUDE_PROJECT_DIR/src/bin.ts" && -f "$CLAUDE_PROJECT_DIR/package.json" ]]; then
  grep -q '"name": "monsthera"' "$CLAUDE_PROJECT_DIR/package.json" 2>/dev/null && in_scope=1
fi
[[ "$in_scope" -eq 0 ]] && exit 0

# ----- Phase B — Capture state (read-only) --------------------------------------
findings=()
warnings=()
hints=()

GLOBAL_VER="$(monsthera --version 2>/dev/null || echo missing)"
LOCAL_VER="$(node -p "require('$CLAUDE_PROJECT_DIR/package.json').version" 2>/dev/null || echo n/a)"
HAS_NODE_MODULES="no"; [[ -d "$CLAUDE_PROJECT_DIR/node_modules" ]] && HAS_NODE_MODULES="yes"
HAS_PACKAGE_JSON="no"; [[ -f "$CLAUDE_PROJECT_DIR/package.json" ]] && HAS_PACKAGE_JSON="yes"

SELF_STATUS_JSON=""
if command -v jq >/dev/null 2>&1 && [[ "$GLOBAL_VER" != "missing" ]]; then
  SELF_STATUS_JSON="$(_timeout 2 monsthera self status --json --repo "$CLAUDE_PROJECT_DIR" 2>/dev/null)"
fi

DOLT_RUNNING=""
if [[ -n "$SELF_STATUS_JSON" ]]; then
  DOLT_RUNNING="$(printf '%s' "$SELF_STATUS_JSON" | jq -r '.processes.dolt.running // empty' 2>/dev/null)"
fi

# `monsthera status --json` for codeInventory.built (M3 phase 4 stat provider).
# Filter NDJSON log stream by selecting the SystemStatus object by shape.
CODE_INVENTORY_BUILT=""
if command -v jq >/dev/null 2>&1 && [[ "$GLOBAL_VER" != "missing" ]]; then
  CODE_INVENTORY_BUILT="$(_timeout 2 monsthera status --json --repo "$CLAUDE_PROJECT_DIR" 2>/dev/null \
    | jq -r 'select(type=="object" and has("version") and has("subsystems")) | .stats.codeInventory.built // empty' 2>/dev/null)"
fi

UPDATE_BLOCKED=""
if [[ "$GLOBAL_VER" != "missing" && "$GLOBAL_VER" != "$LOCAL_VER" ]]; then
  UPDATE_DRY="$(_timeout 3 monsthera self update --dry-run 2>/dev/null)"
  if printf '%s' "$UPDATE_DRY" | grep -q "Blockers:"; then
    if printf '%s' "$UPDATE_DRY" | awk '/^Blockers:/{flag=1;next}/^$/{flag=0}flag' | grep -qE '\S'; then
      UPDATE_BLOCKED="yes"
    fi
  fi
fi

# ----- Phase C — Conservative auto-fix ------------------------------------------
# Sanitiser: redact common auth-token shapes before showing the autofix log to
# the agent. pnpm itself redacts its own registry tokens as `[hidden]`, but
# other tools invoked transitively may not.
_redact_secrets() {
  sed -E \
    -e 's/Bearer [A-Za-z0-9._~+\/=-]+/Bearer [REDACTED]/g' \
    -e 's/npm_[A-Za-z0-9]+/npm_[REDACTED]/g' \
    -e 's/ghp_[A-Za-z0-9]+/ghp_[REDACTED]/g' \
    -e 's/gho_[A-Za-z0-9]+/gho_[REDACTED]/g' \
    -e 's/ghu_[A-Za-z0-9]+/ghu_[REDACTED]/g' \
    -e 's/ghs_[A-Za-z0-9]+/ghs_[REDACTED]/g' \
    -e 's/ghr_[A-Za-z0-9]+/ghr_[REDACTED]/g' \
    -e 's/glpat-[A-Za-z0-9_-]+/glpat-[REDACTED]/g' \
    -e 's/AKIA[A-Z0-9]{16}/AKIA[REDACTED]/g'
}

AUTOFIX_APPLIED=""
AUTOFIX_LOG=""
if [[ "$HAS_PACKAGE_JSON" == "yes" && "$HAS_NODE_MODULES" == "no" ]]; then
  if command -v pnpm >/dev/null 2>&1; then
    AUTOFIX_LOG="$(cd "$CLAUDE_PROJECT_DIR" && pnpm install --prefer-offline 2>&1 | tail -5 | _redact_secrets)"
    if [[ -d "$CLAUDE_PROJECT_DIR/node_modules" ]]; then
      AUTOFIX_APPLIED="yes"
    else
      AUTOFIX_APPLIED="failed"
    fi
  else
    hints+=("- ℹ \`pnpm\` is not on PATH; install pnpm and run \`pnpm install --prefer-offline\` manually.")
  fi
fi

# ----- Phase D — Smart-output ---------------------------------------------------
if [[ "$AUTOFIX_APPLIED" == "yes" ]]; then
  findings+=("- ✓ Installed \`node_modules\` via \`pnpm install --prefer-offline\`.")
elif [[ "$AUTOFIX_APPLIED" == "failed" ]]; then
  warnings+=("- ✗ \`pnpm install --prefer-offline\` failed. Last lines:\n\`\`\`\n$AUTOFIX_LOG\n\`\`\`\nRun manually from the repo.")
fi

if [[ "$GLOBAL_VER" == "missing" && "$LOCAL_VER" != "n/a" ]]; then
  hints+=("- ℹ \`monsthera\` global binary not on PATH. Use \`pnpm exec tsx src/bin.ts ...\` from the repo.")
elif [[ "$GLOBAL_VER" != "missing" && "$LOCAL_VER" != "n/a" && "$GLOBAL_VER" != "$LOCAL_VER" ]]; then
  if [[ "$UPDATE_BLOCKED" == "yes" ]]; then
    warnings+=("- ⚠ Version drift: global binary \`v$GLOBAL_VER\` vs repo \`v$LOCAL_VER\`. \`monsthera self update --dry-run\` reports blockers — review them before executing the update.")
  else
    warnings+=("- ⚠ Version drift: global binary \`v$GLOBAL_VER\` vs repo \`v$LOCAL_VER\`. Consider \`monsthera self update --execute\`.")
  fi
fi

if [[ "$CODE_INVENTORY_BUILT" == "false" ]]; then
  hints+=("- ℹ Code inventory not built. Before \`monsthera code query\` run \`monsthera code reindex\`.")
fi

if [[ -n "$DOLT_RUNNING" && "$DOLT_RUNNING" == "false" ]]; then
  warnings+=("- ⚠ Managed Dolt is down. Run \`monsthera self restart dolt\` if you need it.")
fi

if (( ${#findings[@]} + ${#warnings[@]} + ${#hints[@]} > 0 )); then
  printf '## Monsthera bootstrap\n\n'
  for line in "${findings[@]}"; do printf '%b\n' "$line"; done
  for line in "${warnings[@]}"; do printf '%b\n' "$line"; done
  for line in "${hints[@]}"; do printf '%b\n' "$line"; done
fi

# ----- Phase E — Cognitive briefing ---------------------------------------------
# Opens a Monsthera session for the detected agent and emits a short handoff
# teaser under `## Monsthera briefing`. Independent of Phases A-D: the env
# layer above is about whether the toolchain works; this is about what the
# previous session did.
#
# Hard rules (same as Phases A-D):
#   - capped at 5s, never blocks startup
#   - silent if the CLI is missing or the session subcommand is unsupported
#     (older Monsthera versions); we treat empty output as "nothing to surface"
#   - agent detection precedence: MONSTHERA_AGENT_ID > CLAUDE_* env > CODEX_* env
#   - the teaser text comes from `monsthera session open --teaser-only`, which
#     also creates the session record; the next `monsthera session close` is
#     the agent's responsibility (see `docs/agent-bootstrap-guide.md`).

if [[ "$GLOBAL_VER" != "missing" ]]; then
  AGENT_ID=""
  [[ -n "${CLAUDECODE:-}${CLAUDE_CODE_SESSION:-}" ]] && AGENT_ID="claude-code"
  [[ -n "${CODEX_HOME:-}${CODEX_CLI:-}" ]] && AGENT_ID="codex-cli"
  [[ -n "${MONSTHERA_AGENT_ID:-}" ]] && AGENT_ID="$MONSTHERA_AGENT_ID"

  if [[ -n "$AGENT_ID" ]]; then
    BRIEFING="$(_timeout 5 monsthera session open \
      --agent "$AGENT_ID" \
      --repo "$CLAUDE_PROJECT_DIR" \
      --teaser-only 2>/dev/null)"
    if [[ -n "$BRIEFING" ]]; then
      printf '\n## Monsthera briefing\n\n%s\n' "$BRIEFING"
    fi
  fi
fi

exit 0
```

After saving:

```bash
chmod +x ~/.claude/scripts/monsthera-bootstrap.sh
```

**Smoke test the script standalone before wiring any agent:**

```bash
# Out-of-scope: instant silent
cd /tmp && bash ~/.claude/scripts/monsthera-bootstrap.sh; echo "rc=$?"
# Expect: no output, rc=0, returns in <50ms

# In-scope, first run: ## Monsthera briefing appears with "Starting fresh"
cd /path/to/your/monsthera-consumer-repo && \
  MONSTHERA_AGENT_ID=claude-code bash ~/.claude/scripts/monsthera-bootstrap.sh
# Expect: a "## Monsthera briefing" block referencing a new session id

# In-scope, second run after a `monsthera session close`: briefing references the
# previous session's handoff article
cd /path/to/your/monsthera-consumer-repo && \
  monsthera session close --note "smoke" && \
  MONSTHERA_AGENT_ID=claude-code bash ~/.claude/scripts/monsthera-bootstrap.sh
# Expect: briefing points at handoff-ses-<previous-id>
```

---

## Step 2 — Wire Claude Code (`SessionStart` hook)

Edit `~/.claude/settings.json`. Append a new entry to `hooks.SessionStart` without disturbing existing entries. The command uses a portable bash watchdog to enforce a 30 s outer cap (works on macOS without coreutils):

```jsonc
{
  "hooks": {
    "SessionStart": [
      // ... your existing entries (preserve them) ...
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'b=\"$HOME/.claude/scripts/monsthera-bootstrap.sh\"; \"$b\" & p=$!; (sleep 30 && kill -TERM $p 2>/dev/null) & w=$!; wait $p; kill $w 2>/dev/null; exit 0'"
          }
        ]
      }
    ]
  }
}
```

If you have GNU coreutils installed (`brew install coreutils`), the simpler form works too:

```jsonc
"command": "gtimeout 30s $HOME/.claude/scripts/monsthera-bootstrap.sh"
```

**Verify:**

```bash
jq '.hooks.SessionStart | length' ~/.claude/settings.json   # expect: previous count + 1
jq -r '.hooks.SessionStart[-1].hooks[0].command' ~/.claude/settings.json   # expect: contains "monsthera-bootstrap.sh"
```

Then open a fresh Claude Code session in your Monsthera-related repo. The bootstrap output appears either silently (healthy) or as a `## Monsthera bootstrap` block in the session-start context.

---

## Step 3 — Wire Codex CLI (shell function)

Append to `~/.zshrc` (or `~/.bashrc`):

```bash
# Monsthera bootstrap wrapper for Codex CLI
# Phase A scope detection makes this an instantaneous no-op outside Monsthera repos.
codex() {
  bash "$HOME/.claude/scripts/monsthera-bootstrap.sh"
  command codex "$@"
}
```

**Verify:**

```bash
source ~/.zshrc
type codex                    # expect: shell function from ~/.zshrc
cd /tmp && codex --help       # expect: codex help, no bootstrap line above (out-of-scope)
cd /path/to/monsthera/repo && codex --help   # expect: silent or bootstrap block, then codex help
```

`command codex` (rather than `\codex`) explicitly bypasses function/alias resolution and is portable across zsh and bash.

**Note on frequency:** the wrapper runs the script on every `codex` invocation. Phase A's scope detection makes it instantaneous outside Monsthera repos, but if you run `codex` extremely often inside a Monsthera repo, you can add a debounce by checking `/tmp/monsthera-bootstrap.last` mtime:

```bash
codex() {
  local stamp="/tmp/monsthera-bootstrap.last"
  if [[ -z "$(find "$stamp" -newermt '60 seconds ago' 2>/dev/null)" ]]; then
    bash "$HOME/.claude/scripts/monsthera-bootstrap.sh" && touch "$stamp"
  fi
  command codex "$@"
}
```

---

## Step 4 — Wire Codex agent context (`AGENTS.md`)

This is the safety net for the Codex desktop app, which spawns sessions outside the user's shell and so cannot benefit from Step 3's wrapper. Append to `~/.codex/AGENTS.md`:

```markdown
## Monsthera bootstrap helper

When opening a session in a Monsthera-related repo (the Monsthera repo, a worktree of it, or any consumer that depends on it), a helper script lives at `~/.claude/scripts/monsthera-bootstrap.sh`. It is the same script Claude Code runs as a `SessionStart` hook and that the local `codex()` shell wrapper runs before launching `codex` from a terminal.

If you suspect environment drift (`tsx not found`, `monsthera` binary missing, version skew between the global binary and the repo's `package.json`, code inventory not built, managed Dolt process down) OR you want to see what the previous session left unfinished, invoke the script via Bash and read its output:

\`\`\`bash
MONSTHERA_AGENT_ID=codex-cli bash ~/.claude/scripts/monsthera-bootstrap.sh
\`\`\`

Properties:

- **Idempotent and safe to run multiple times.** No side effects beyond `pnpm install --prefer-offline` when `node_modules/` is missing, plus opening (and superseding any prior open) Monsthera session for the detected agent.
- **Silent when nothing is actionable.** If no output, the environment is healthy AND there is no previous handoff to surface.
- **Two output blocks, both optional.**
  - `## Monsthera bootstrap` — environment diagnostics (severity-ordered).
  - `## Monsthera briefing` — pointer to the previous session's handoff article, plus an orphan warning if the prior async worker did not finish.
- **What it auto-fixes.** Only `pnpm install --prefer-offline` when `node_modules/` is missing.
- **What it does NOT auto-fix.** `monsthera self update --execute`, `monsthera code reindex`, `monsthera self restart dolt`, missing handoff articles (use `monsthera session _generate-handoff <id>` manually if needed), or any other state-modifying operation.

If the script reports a version drift with blockers, run `monsthera self update --dry-run` to see the blocker list before proposing any fix.

If the briefing surfaces an orphan warning (`⚠ Previous handoff is incomplete`), run the recovery command shown in the warning to regenerate the handoff article from the previously-captured Stage A facts; the Ollama pipeline runs synchronously and writes the missing knowledge article.

**Closing the session before context loss.** Before exiting (or when context compaction is imminent), run `monsthera session close [--note "one-line intent"]`. The CLI returns in ~100 ms; a detached worker spawns and generates the handoff article in the background (~30–60 s on Ollama). The agent does not need to wait. The next session start picks up the article and shows the briefing.
```

**Verify:** open a fresh Codex session and ask the agent: *"What helper scripts do I have for Monsthera environment diagnostics?"* It should mention `monsthera-bootstrap.sh` and offer to invoke it. (Non-deterministic LLM check; the deterministic terminal coverage comes from Step 3.)

---

## Step 5 — Agent responsibility on the way out

The bootstrap script handles the **way in** (opens a session, surfaces the previous handoff). The **way out** is the agent's job: call `monsthera session close` before exit or context compaction so the next session has something to read.

Recommended pattern, in the agent's session-end protocol (CLAUDE.md / AGENTS.md / equivalent):

```bash
# Default: async fire-and-forget. Returns in ~100 ms; a detached worker
# generates the handoff article via Ollama in the background (~30-60 s).
monsthera session close --note "one-line intent or accomplishment"

# When you need the handoff inline (CI smoke tests, debugging, no Ollama):
monsthera session close --note "..." --sync

# When Ollama is unavailable but you still want the lifecycle closed:
monsthera session close --note "..." --no-llm
```

What the agent contributes — the entire token cost on the way out — is the `--note` string. Everything else (event log, work touched, knowledge created, code diffs, commits, signals, narrative, decisions, next steps, citations) is captured automatically by Stage A + local Ollama. A one-line note costs ~10–50 tokens; the rest of the ~5 KB handoff article is generated for free by the local model.

If the agent forgets to close, the next `monsthera session open` will detect the lingering open session and mark it `abandoned` (reason: `superseded`). The work isn't lost — `facts.json` is still extractable from `monsthera session _generate-handoff <id>` against the prior session, but the lifecycle is no longer recoverable as a "completed" handoff.

### When to call `session close`

- Before quitting Claude Code / Codex CLI normally.
- When approaching the context window limit (compaction is imminent).
- After landing a coherent piece of work (a merged PR, a milestone, a shipped feature). You can open a fresh session immediately afterward — short sessions produce sharper handoffs than long, multi-topic ones.

### When to skip `session close`

- Throwaway shell sessions where Monsthera was used only for `monsthera search` or `monsthera knowledge get` with no mutations.
- CI runs where the session lifecycle has no consumer.

### Teaching the agent the close protocol (recommended)

The Phase E teaser already includes a one-line reminder of the close command — that gets the agent ~95% of the way. For a more bulletproof setup, drop the snippet below into your global agent instructions (`~/.claude/CLAUDE.md` for Claude Code; the equivalent in Codex). This guarantees the protocol survives any future change to the teaser format.

```markdown
## Monsthera sessions

When the user says "cierra session", "close session", "end session", or signals
they are about to stop / context is about to compact:

1. Run `monsthera session close --note "<one-line intent>"`.
2. The CLI returns in ~100 ms. Do NOT wait for the LLM — a detached worker
   generates the handoff article in the background. Stdout of the close
   command is enough; you do not need to poll for completion.
3. If the close errors with `NOT_FOUND`, no session is currently open
   for this agent+repo — fine, nothing to close.
4. If Ollama is unreachable (you see `degraded — Ollama unavailable`),
   re-run with `--no-llm` to force a T1-only handoff (Hypergraph + Facts,
   no narrative). This keeps the lifecycle intact even when the local
   model is down.
5. The `--note` argument is the ONLY content you contribute. Everything
   else (events, work, knowledge, code diffs, commits) is captured by
   Stage A automatically and summarized by local Ollama. Keep `--note`
   to a single line of intent or accomplishment.

Common modes:
- `monsthera session close --note "shipped M3 phase 5"` — async default
- `monsthera session close --note "..." --sync` — block until article ready
- `monsthera session close --note "..." --no-llm` — Ollama-free, T1-only
```

The above is a verbatim copy-paste template. Customise the trigger phrases ("cierra session", etc.) to match how you actually talk to the agent.

---

## Customization

| You want to... | Edit |
|---|---|
| **Restrict scope to a single repo** | Phase A in the script — replace the three OR'd checks with a hardcoded path equality (`[[ "$CLAUDE_PROJECT_DIR" == "/path/to/your/repo" ]]`). |
| **Add more diagnostics** (e.g. Ollama health) | Phase B — add another `monsthera doctor` call gated by your own timeout. Be honest with yourself about the latency cost. |
| **Auto-run `code reindex` on first session** | Phase C — add another `if` block. Be aware: `code reindex` shells `git ls-files` and re-extracts symbols, ~5-30 s on real repos. |
| **Disable the script per-repo** | Add a `[[ -f "$CLAUDE_PROJECT_DIR/.monsthera-bootstrap.disabled" ]] && exit 0` check at the top. |
| **Track when the script ran (audit)** | Add `echo "$(date -u +%FT%TZ) $CLAUDE_PROJECT_DIR" >> ~/.monsthera-bootstrap.log` at the end of Phase A (in-scope branch). |
| **Disable the cognitive briefing only** | Remove Phase E from the script (or guard it with `[[ -n "$MONSTHERA_SKIP_BRIEFING" ]] && exit 0` before the `if [[ "$GLOBAL_VER" != "missing" ]]` block). The bootstrap diagnostics keep working. |
| **Force a specific agent identity** | Set `MONSTHERA_AGENT_ID=<id>` in your `~/.zshrc` / `~/.bashrc`. Overrides the `CLAUDE_*` / `CODEX_*` env auto-detection. Useful when you run multiple agent types from the same shell. |
| **Disable LLM-generated handoff narrative** | Set `MONSTHERA_SESSIONS_LLM_ENABLED=false`. Sessions still open/close and track lifecycle, but every handoff article is T1-only (metadata + Hypergraph, no Ollama narrative). |
| **Change the local Ollama model** | Set `MONSTHERA_SESSIONS_LLM_MODEL=qwen2.5-coder:7b` (or any other chat-capable model your local Ollama serves). Default is `qwen2.5-coder:7b`. |
| **Tune Ollama timeout** | Set `MONSTHERA_SESSIONS_LLM_TIMEOUT_MS=60000` (default). Larger handoffs benefit from longer timeouts; CI may prefer shorter. |
| **Capture the async worker's stdio for debugging** | Set `MONSTHERA_SESSIONS_WORKER_LOG=/tmp/monsthera-worker.log`. The detached handoff worker appends its stdout+stderr there. |

---

## Troubleshooting

**The script fires but emits nothing.** That is the success case — your environment is healthy from the script's perspective. To verify, run with `MONSTHERA_BOOTSTRAP_DEBUG=1` and inspect `/tmp/monsthera-bootstrap.debug.log`.

**Bootstrap output never reaches the Claude Code agent.** Confirm the hook is registered: `jq '.hooks.SessionStart' ~/.claude/settings.json`. Confirm the script is executable: `ls -la ~/.claude/scripts/monsthera-bootstrap.sh`. Try running the wrapper command literally from your shell — if it works there, the issue is on the Claude Code side.

**`type codex` still shows the binary path after editing `~/.zshrc`.** You did not source the file in this terminal. Run `source ~/.zshrc` or open a new terminal.

**The Codex agent does not invoke the script when asked.** Confirm `~/.codex/AGENTS.md` was edited: `grep -n 'Monsthera bootstrap helper' ~/.codex/AGENTS.md`. AGENTS.md content is non-deterministic — the agent may decide the question doesn't warrant invoking the script. The deterministic coverage for terminal-launched sessions is Step 3.

**Auth tokens leak into the agent context.** The script redacts `Bearer ...`, `npm_*`, `ghp_*`, `gho_*`, `ghu_*`, `ghs_*`, `ghr_*`, `glpat-*`, and `AKIA[A-Z0-9]{16}` patterns from `pnpm install` output. If your toolchain emits other token shapes, extend the `_redact_secrets` function in Phase C.

**The hook adds visible latency to session start.** The 30 s outer cap is the worst case. Typical: <300 ms in-scope healthy (Phase E adds ~100-200 ms for `session open`), ~10 s in-scope when `pnpm install` actually runs (first time only), <50 ms out-of-scope. If you see consistent multi-second delays in healthy sessions, run with `MONSTHERA_BOOTSTRAP_DEBUG=1` and check which CLI call is slow.

**The `## Monsthera briefing` block never appears even though I'm in a Monsthera repo.** Check, in order: (1) `monsthera --version` works from the shell that runs the hook; (2) `monsthera session open --teaser-only --agent claude-code --repo <repo>` produces output when run manually — if it doesn't, Phase E is silent by design; (3) the agent identity was detected (set `MONSTHERA_AGENT_ID=claude-code` and re-run); (4) the Monsthera CLI is recent enough to ship the `session` subcommand (`monsthera session --help` should not error).

**The briefing shows `⚠ Previous handoff is incomplete`.** The previous session's async worker did not finish writing the handoff article. Causes: Ollama was unreachable / slow, the worker crashed, or the parent shell killed the detached subprocess. Recovery: run the command the warning prints (`monsthera session _generate-handoff <id>`); it loads the previously-captured Stage A facts from disk and re-runs Stages B/C/D synchronously.

**The handoff article body says `Handoff is degraded — LLM pipeline did not run`.** Phase E ran cleanly but `session close` ran with Ollama unreachable or `--no-llm`. The session lifecycle is intact; the Hypergraph + Facts sections still have value. To regenerate with the LLM, ensure Ollama is up and the configured model (`MONSTHERA_SESSIONS_LLM_MODEL`, default `qwen2.5-coder:7b`) is pulled, then run `monsthera session _generate-handoff <id>`.

**Async worker silently fails to produce the handoff article.** Set `MONSTHERA_SESSIONS_WORKER_LOG=/tmp/monsthera-worker.log` before `session close` and inspect the log. The most common failure in dev (running via `tsx`) is the loader not being registered for the child process — Monsthera handles this by prepending `--import tsx` automatically when the entry script ends in `.ts`, but custom tsx installations may behave differently.

---

## Further reading

- [`consumer-setup.md`](consumer-setup.md) — wiring Monsthera as an MCP server / CLI in a downstream repo (prerequisites for this guide).
- [`adrs/017-code-intelligence-m3-lightweight-inventory.md`](adrs/017-code-intelligence-m3-lightweight-inventory.md) — the M3 ADR that introduced `stats.codeInventory.built` and `monsthera code reindex`, both surfaced by Phase B.
- [`adrs/014-portable-workspace-operations.md`](adrs/014-portable-workspace-operations.md) — the JSON-first / Dolt-optional contract that the script honours when probing `monsthera self status`.
