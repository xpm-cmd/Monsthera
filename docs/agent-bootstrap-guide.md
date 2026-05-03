# Agent bootstrap guide — Claude Code & Codex CLI

**Audience:** anyone using Monsthera as an MCP server / CLI from their AI coding agent (Claude Code, Codex CLI, Codex desktop). This is an **optional** UX layer on top of [`consumer-setup.md`](consumer-setup.md). It does not change how Monsthera works — it just makes your agent aware of the project state at session start so the first turns aren't spent diagnosing missing dependencies or version drift.

If you are still wiring Monsthera itself, read [`consumer-setup.md`](consumer-setup.md) first. Come back here once `monsthera --version` works from your shell.

---

## What this gives you

A single bash helper script that runs once per agent session in any Monsthera-related repository (the Monsthera repo itself, a worktree of it, or any consumer repo that depends on it). The script:

1. **Detects scope** — exits silently in <50 ms when the current directory is not Monsthera-related, so unrelated projects pay nothing.
2. **Auto-fixes one specific thing** — runs `pnpm install --prefer-offline` when `node_modules/` is missing (idempotent, ~10 s on a cold cache, ~1 s when not needed). Nothing else is auto-fixed.
3. **Diagnoses state** — version drift between the global `monsthera` binary and the consumer repo's `package.json`, managed Dolt process state, whether the M3 code inventory has been built, and whether `monsthera self update --dry-run` reports blockers.
4. **Smart-output** — emits a single markdown block to the agent's session context **only when something is actionable**. Healthy sessions produce zero output and zero token cost.

The same script reaches three integration points:

| Agent | Mechanism | Coverage |
|---|---|---|
| **Claude Code** | `SessionStart` hook in `~/.claude/settings.json` | every session start, deterministic |
| **Codex CLI** (terminal) | `codex()` shell function in `~/.zshrc` / `~/.bashrc` | every `codex` invocation from a shell, deterministic |
| **Codex desktop / agent** | `~/.codex/AGENTS.md` mention | non-deterministic safety net (the agent learns the script exists and can invoke it on suspicion) |

---

## Design decisions (summary)

The script's design is locked by five trade-offs. You can adjust them — see [Customization](#customization).

| # | Decision | Default | Alternative if your needs differ |
|---|---|---|---|
| 1 | **Scope** | Detects Monsthera-related repos via three OR'd checks: `.monsthera/` directory present, or `package.json` mentions `"monsthera"`, or repo has `src/bin.ts` and `"name": "monsthera"`. | If you want a single repo only, replace the detection with a hardcoded path equality check. |
| 2 | **Diagnostic depth** | Medium: version drift, Dolt running, code inventory built, update blockers. Skips the slow `monsthera doctor` (5-10 s). | For richer info (Ollama embedding health, search index state), call `monsthera doctor` instead, but expect ~5-10 s on every session. |
| 3 | **Failure mode** | Conservative: only `pnpm install --prefer-offline` is auto-run. Everything else surfaces as a hint for the agent or human to act on. | If you want to auto-run `monsthera self update` or `code reindex`, you can extend Phase C. Be aware these can block sessions on first run. |
| 4 | **Packaging** | External bash script invoked by a one-line command in each integration point. | A native `monsthera self bootstrap` subcommand could replace this, but creates chicken-and-egg coupling (the binary is what we're checking). Bash stays portable and dependency-free. |
| 5 | **Codex integration** | Both shell function (CLI deterministic) and AGENTS.md (desktop safety net). Same script powers both. | If you only use Codex CLI, skip the AGENTS.md step. If you only use the desktop app, skip the shell function. |

For the full rationale (including alternatives considered and rejected), see the [original design spec](#further-reading).

---

## Components — what the script does

Four phases, executed sequentially:

**Phase A — Scope detection.** Three OR'd checks. If none match, `exit 0` silent (~5-20 ms).

**Phase B — State capture (read-only, ~200 ms-2 s).** Calls `monsthera --version`, reads `package.json` version, checks for `node_modules/`, runs `monsthera self status --json` (capped at 2 s, parsed for `processes.dolt.running`), runs `monsthera status --json` (capped at 2 s, parsed for `stats.codeInventory.built`), and only when versions diverge runs `monsthera self update --dry-run` to detect blockers.

**Phase C — Conservative auto-fix.** If `package.json` exists and `node_modules/` does not, runs `pnpm install --prefer-offline`. Records success/failure for the output stage.

**Phase D — Smart-output.** Collects findings/warnings/hints into three arrays. Emits a single markdown block under `## Monsthera bootstrap` heading (severity-ordered) **only if any array is non-empty**. Healthy sessions produce no output.

Hard rules:

- `set +e` and `trap 'exit 0' EXIT` — the script never aborts the session, even on internal bugs.
- `stdout` is the agent context; `stderr` is debug only.
- Inner timeouts (2 s on each Monsthera CLI call) use a portable bash helper that prefers `gtimeout`/`timeout` and falls back to a background+watchdog pattern. Outer timeout (30 s for the whole script) is enforced by the caller (the hook command).
- Auth tokens (`Bearer ...`, `npm_...`, `ghp_...`, `glpat-...`, AWS access keys) are redacted from any captured `pnpm install` log before being shown to the agent.
- `MONSTHERA_BOOTSTRAP_DEBUG=1` enables `set -x` and writes the trace to `/tmp/monsthera-bootstrap.debug.log`.

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

# In-scope: silent if healthy, otherwise a single ## Monsthera bootstrap block
cd /path/to/your/monsthera-consumer-repo && bash ~/.claude/scripts/monsthera-bootstrap.sh
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

If you suspect environment drift (`tsx not found`, `monsthera` binary missing, version skew between the global binary and the repo's `package.json`, code inventory not built, managed Dolt process down), invoke the script via Bash and read its output:

\`\`\`bash
bash ~/.claude/scripts/monsthera-bootstrap.sh
\`\`\`

Properties:

- **Idempotent and safe to run multiple times.** No side effects beyond `pnpm install --prefer-offline` when `node_modules/` is missing.
- **Silent when nothing is actionable.** If no output, the environment is healthy from the script's perspective; do not retry.
- **Output format.** A single markdown block under `## Monsthera bootstrap`, ordered by severity (autofix-applied → warnings → hints).
- **What it auto-fixes.** Only `pnpm install --prefer-offline` when `node_modules/` is missing.
- **What it does NOT auto-fix.** `monsthera self update --execute`, `monsthera code reindex`, `monsthera self restart dolt`, or any other state-modifying operation.

If the script reports a version drift with blockers, run `monsthera self update --dry-run` to see the blocker list before proposing any fix.
```

**Verify:** open a fresh Codex session and ask the agent: *"What helper scripts do I have for Monsthera environment diagnostics?"* It should mention `monsthera-bootstrap.sh` and offer to invoke it. (Non-deterministic LLM check; the deterministic terminal coverage comes from Step 3.)

---

## Customization

| You want to... | Edit |
|---|---|
| **Restrict scope to a single repo** | Phase A in the script — replace the three OR'd checks with a hardcoded path equality (`[[ "$CLAUDE_PROJECT_DIR" == "/path/to/your/repo" ]]`). |
| **Add more diagnostics** (e.g. Ollama health) | Phase B — add another `monsthera doctor` call gated by your own timeout. Be honest with yourself about the latency cost. |
| **Auto-run `code reindex` on first session** | Phase C — add another `if` block. Be aware: `code reindex` shells `git ls-files` and re-extracts symbols, ~5-30 s on real repos. |
| **Disable the script per-repo** | Add a `[[ -f "$CLAUDE_PROJECT_DIR/.monsthera-bootstrap.disabled" ]] && exit 0` check at the top. |
| **Track when the script ran (audit)** | Add `echo "$(date -u +%FT%TZ) $CLAUDE_PROJECT_DIR" >> ~/.monsthera-bootstrap.log` at the end of Phase A (in-scope branch). |

---

## Troubleshooting

**The script fires but emits nothing.** That is the success case — your environment is healthy from the script's perspective. To verify, run with `MONSTHERA_BOOTSTRAP_DEBUG=1` and inspect `/tmp/monsthera-bootstrap.debug.log`.

**Bootstrap output never reaches the Claude Code agent.** Confirm the hook is registered: `jq '.hooks.SessionStart' ~/.claude/settings.json`. Confirm the script is executable: `ls -la ~/.claude/scripts/monsthera-bootstrap.sh`. Try running the wrapper command literally from your shell — if it works there, the issue is on the Claude Code side.

**`type codex` still shows the binary path after editing `~/.zshrc`.** You did not source the file in this terminal. Run `source ~/.zshrc` or open a new terminal.

**The Codex agent does not invoke the script when asked.** Confirm `~/.codex/AGENTS.md` was edited: `grep -n 'Monsthera bootstrap helper' ~/.codex/AGENTS.md`. AGENTS.md content is non-deterministic — the agent may decide the question doesn't warrant invoking the script. The deterministic coverage for terminal-launched sessions is Step 3.

**Auth tokens leak into the agent context.** The script redacts `Bearer ...`, `npm_*`, `ghp_*`, `gho_*`, `ghu_*`, `ghs_*`, `ghr_*`, `glpat-*`, and `AKIA[A-Z0-9]{16}` patterns from `pnpm install` output. If your toolchain emits other token shapes, extend the `_redact_secrets` function in Phase C.

**The hook adds visible latency to session start.** The 30 s outer cap is the worst case. Typical: <100 ms in-scope healthy, ~10 s in-scope when `pnpm install` actually runs (first time only), <50 ms out-of-scope. If you see consistent multi-second delays in healthy sessions, run with `MONSTHERA_BOOTSTRAP_DEBUG=1` and check which CLI call is slow.

---

## Further reading

- [`consumer-setup.md`](consumer-setup.md) — wiring Monsthera as an MCP server / CLI in a downstream repo (prerequisites for this guide).
- [`adrs/017-code-intelligence-m3-lightweight-inventory.md`](adrs/017-code-intelligence-m3-lightweight-inventory.md) — the M3 ADR that introduced `stats.codeInventory.built` and `monsthera code reindex`, both surfaced by Phase B.
- [`adrs/014-portable-workspace-operations.md`](adrs/014-portable-workspace-operations.md) — the JSON-first / Dolt-optional contract that the script honours when probing `monsthera self status`.
