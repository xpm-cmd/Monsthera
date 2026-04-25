import { detectWorktree } from "./core/worktree.js";
import { main } from "./cli/main.js";

const args = process.argv.slice(2);

// Subcommands that legitimately run from the main repo even when a caller
// pins the worktree-only invariant (e.g. `install-hook` writes to the
// main `.git/hooks` dir; refusing to run there would defeat its purpose).
const EXEMPT_SUBCOMMANDS = new Set(["install-hook", "uninstall-hook"]);
// Flags that must always succeed — failing `--help` or `--version` for an
// environment-policy reason is hostile and breaks tooling that probes the
// CLI before deciding what to dispatch.
const EXEMPT_FLAGS = new Set(["--help", "-h", "--version", "-v"]);

const subcommand = args.find((a) => !a.startsWith("-"));
const exempt =
  (subcommand !== undefined && EXEMPT_SUBCOMMANDS.has(subcommand)) ||
  args.some((a) => EXEMPT_FLAGS.has(a));

const requireWorktree =
  args.includes("--assert-worktree") ||
  process.env["MONSTHERA_REQUIRE_WORKTREE"] === "true";

async function bootstrap(): Promise<void> {
  if (requireWorktree && !exempt) {
    const status = await detectWorktree(process.cwd());
    if (!status.isWorktree) {
      process.stderr.write(
        "monsthera: refusing to run from main repo (worktree required). " +
          "Create a worktree or unset MONSTHERA_REQUIRE_WORKTREE / remove --assert-worktree.\n",
      );
      // Exit code 2 distinguishes a worktree-policy refusal from a generic
      // command failure (1) or a lint-found-drift exit (also 1).
      process.exit(2);
    }
  }
  // Strip the global flag before subcommand dispatch — individual command
  // handlers do not know about `--assert-worktree`.
  const dispatchArgs = args.filter((a) => a !== "--assert-worktree");
  await main(dispatchArgs);
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
