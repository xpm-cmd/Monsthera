import { describe, expect, it } from "vitest";
import {
  extractDiffSignals,
  listCodeTouchedSinceBase,
  listCommitsInRange,
  listCommitsInWindow,
  resolveBaseSha,
} from "../../../src/sessions/facts-extractor-git.js";
import type { CommandRunner, CommandSpec } from "../../../src/ops/command-runner.js";
import { err, ok } from "../../../src/core/result.js";
import { StorageError } from "../../../src/core/errors.js";

function recordingRunner(stdout: string): { runner: CommandRunner; calls: CommandSpec[] } {
  const calls: CommandSpec[] = [];
  const runner: CommandRunner = async (spec) => {
    calls.push(spec);
    return ok({ stdout, stderr: "" });
  };
  return { runner, calls };
}

describe("resolveBaseSha", () => {
  it("invokes `git rev-list -1 --before=<openedAt> HEAD` in the repo and returns the trimmed sha", async () => {
    const { runner, calls } = recordingRunner("abc123def456\n");

    const result = await resolveBaseSha({
      repo: "/tmp/repo",
      openedAt: "2026-05-12T23:00:00Z",
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("abc123def456");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("git");
    expect(calls[0]!.args).toEqual(["rev-list", "-1", "--before=2026-05-12T23:00:00Z", "HEAD"]);
    expect(calls[0]!.cwd).toBe("/tmp/repo");
  });
});

describe("listCommitsInWindow", () => {
  it("parses `%H|%s|%cI` lines into SessionFactsCommit objects", async () => {
    const stdout = [
      "abc1234deadbeef|feat: add foo|2026-05-12T23:05:00+10:00",
      "def5678cafef00d|fix: bug in bar|2026-05-12T23:15:30+10:00",
      "",
    ].join("\n");
    const { runner, calls } = recordingRunner(stdout);

    const result = await listCommitsInWindow({
      repo: "/tmp/repo",
      openedAt: "2026-05-12T23:00:00Z",
      closedAt: "2026-05-12T23:30:00Z",
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { sha: "abc1234deadbeef", subject: "feat: add foo", timestamp: "2026-05-12T23:05:00+10:00" },
      { sha: "def5678cafef00d", subject: "fix: bug in bar", timestamp: "2026-05-12T23:15:30+10:00" },
    ]);
    expect(calls[0]!.command).toBe("git");
    expect(calls[0]!.args).toEqual([
      "log",
      "--since=2026-05-12T23:00:00Z",
      "--until=2026-05-12T23:30:00Z",
      "--format=%H|%s|%cI",
    ]);
    expect(calls[0]!.cwd).toBe("/tmp/repo");
  });

  it("returns ok([]) when git produces no output (no commits in window)", async () => {
    const { runner } = recordingRunner("");

    const result = await listCommitsInWindow({
      repo: "/tmp/repo",
      openedAt: "2026-05-12T23:00:00Z",
      closedAt: "2026-05-12T23:30:00Z",
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("degrades to ok([]) when the runner errors (git missing / not a checkout)", async () => {
    const runner: CommandRunner = async () => err(new StorageError("not a git repository"));

    const result = await listCommitsInWindow({
      repo: "/tmp/repo",
      openedAt: "2026-05-12T23:00:00Z",
      closedAt: "2026-05-12T23:30:00Z",
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

describe("listCommitsInRange (PR-15)", () => {
  it("invokes `git log <range> --format=%H|%s|%cI` and parses commits", async () => {
    const stdout = [
      "aaa111deadbeef|feat: add foo|2026-05-12T23:05:00+10:00",
      "bbb222cafef00d|fix: bug in bar|2026-05-12T23:15:30+10:00",
      "",
    ].join("\n");
    const { runner, calls } = recordingRunner(stdout);

    const result = await listCommitsInRange({ repo: "/tmp/repo", range: "HEAD~2..HEAD", runner });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { sha: "aaa111deadbeef", subject: "feat: add foo", timestamp: "2026-05-12T23:05:00+10:00" },
      { sha: "bbb222cafef00d", subject: "fix: bug in bar", timestamp: "2026-05-12T23:15:30+10:00" },
    ]);
    expect(calls[0]!.command).toBe("git");
    expect(calls[0]!.args).toEqual(["log", "HEAD~2..HEAD", "--format=%H|%s|%cI"]);
    expect(calls[0]!.cwd).toBe("/tmp/repo");
  });

  it("returns err when git fails (bad range surfaces to the caller, unlike the date-window helper)", async () => {
    const runner: CommandRunner = async () => err(new StorageError("fatal: bad revision 'nope..nope'"));
    const result = await listCommitsInRange({ repo: "/tmp/repo", range: "nope..nope", runner });
    expect(result.ok).toBe(false);
  });

  it("returns ok([]) when the range contains no commits", async () => {
    const { runner } = recordingRunner("\n");
    const result = await listCommitsInRange({ repo: "/tmp/repo", range: "HEAD..HEAD", runner });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });
});

describe("listCodeTouchedSinceBase", () => {
  it("parses `git diff --numstat baseSha..HEAD` rows into SessionFactsCodeTouched", async () => {
    const stdout = ["12\t3\tsrc/foo.ts", "0\t0\tsrc/bar.ts"].join("\n");
    const { runner, calls } = recordingRunner(stdout);

    const result = await listCodeTouchedSinceBase({
      repo: "/tmp/repo",
      baseSha: "abc1234",
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { path: "src/foo.ts", linesAdded: 12, linesRemoved: 3 },
      { path: "src/bar.ts", linesAdded: 0, linesRemoved: 0 },
    ]);
    expect(calls[0]!.command).toBe("git");
    expect(calls[0]!.args).toEqual(["diff", "--numstat", "abc1234..HEAD"]);
    expect(calls[0]!.cwd).toBe("/tmp/repo");
  });

  it("treats binary files (numstat `-\\t-`) as `linesAdded: 0, linesRemoved: 0`", async () => {
    const stdout = ["-\t-\tpublic/image.png", "5\t2\tsrc/baz.ts"].join("\n");
    const { runner } = recordingRunner(stdout);

    const result = await listCodeTouchedSinceBase({
      repo: "/tmp/repo",
      baseSha: "abc1234",
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { path: "public/image.png", linesAdded: 0, linesRemoved: 0 },
      { path: "src/baz.ts", linesAdded: 5, linesRemoved: 2 },
    ]);
  });
});

describe("extractDiffSignals", () => {
  it("captures TODO/FIXME/XXX/HACK markers from added lines as `todosAdded`", async () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -0,0 +11,1 @@",
      "+// TODO: wire refresh logic",
    ].join("\n");
    const { runner, calls } = recordingRunner(diff);

    const result = await extractDiffSignals({
      repo: "/tmp/repo",
      baseSha: "abc1234",
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.todosAdded).toEqual([
      { path: "src/foo.ts", line: 11, text: "// TODO: wire refresh logic" },
    ]);
    expect(result.value.questions).toEqual([]);
    expect(calls[0]!.command).toBe("git");
    expect(calls[0]!.args).toEqual(["diff", "--unified=0", "abc1234..HEAD"]);
  });

  it("captures `?`-ending lines as `questions`", async () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -10,1 +10,1 @@",
      "-old line",
      "+// should we keep this?",
    ].join("\n");
    const { runner } = recordingRunner(diff);

    const result = await extractDiffSignals({
      repo: "/tmp/repo",
      baseSha: "abc1234",
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.questions).toEqual([
      { path: "src/foo.ts", line: 10, text: "// should we keep this?" },
    ]);
    expect(result.value.todosAdded).toEqual([]);
  });

  it("tracks distinct paths across multiple file hunks in a single diff", async () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -0,0 +5,1 @@",
      "+// TODO: in foo",
      "diff --git a/src/bar.ts b/src/bar.ts",
      "--- a/src/bar.ts",
      "+++ b/src/bar.ts",
      "@@ -0,0 +20,1 @@",
      "+// what about bar?",
    ].join("\n");
    const { runner } = recordingRunner(diff);

    const result = await extractDiffSignals({
      repo: "/tmp/repo",
      baseSha: "abc1234",
      runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.todosAdded).toEqual([
      { path: "src/foo.ts", line: 5, text: "// TODO: in foo" },
    ]);
    expect(result.value.questions).toEqual([
      { path: "src/bar.ts", line: 20, text: "// what about bar?" },
    ]);
  });
});
