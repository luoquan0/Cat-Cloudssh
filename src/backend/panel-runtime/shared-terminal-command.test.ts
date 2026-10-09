import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildSharedTerminalCommand } from "./shared-terminal-command.js";

const token = "0123456789abcdef0123456789abcdef";
function run(command: string, cwd?: string) {
  const wrapper = buildSharedTerminalCommand(command, cwd, token);
  // A persistent parent is used, not a fresh shell per tool invocation.
  const input =
    "export CLOUDSSH_PARENT_TEST=kept\n" +
    wrapper.replace(/\r$/, "\n") +
    'printf \'\\nPARENT_ALIVE:%s:%s\\n\' "$CLOUDSSH_PARENT_TEST" "$PWD"\n';
  const child = spawnSync("/bin/sh", [], {
    input,
    encoding: "utf8",
    timeout: 5000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stdout).toContain("PARENT_ALIVE:kept:");
  return child.stdout;
}

describe("protected shared terminal commands", () => {
  it.each([
    ["exit 7", 7],
    ["exec printf child-exec", 0],
    ["set -e; false; echo unreachable", 1],
    ["cat", 0],
    ["read answer", 1],
  ])("keeps the parent alive for %s", (command, status) => {
    expect(run(String(command))).toContain(
      `cloudssh-agent-end=${token};status=${status}\x07`,
    );
  });
  it("inherits cwd and exported environment without changing the parent", () => {
    const output = run(
      'printf \'%s:%s\' "$PWD" "$CLOUDSSH_PARENT_TEST"; export CLOUDSSH_PARENT_TEST=changed',
      "/tmp",
    );
    expect(output).toContain("/tmp:kept");
    expect(output).toContain("PARENT_ALIVE:kept:");
  });
  it("preserves unicode, quotes, multiline scripts and heredocs", () => {
    expect(run("cat <<'EOF'\n中文 'quoted' $literal\nEOF\n")).toContain(
      "中文 'quoted' $literal\n",
    );
  });
  it("never places raw terminal control bytes or oversized lines in PTY input", () => {
    const input = buildSharedTerminalCommand(
      "printf '" + "x".repeat(20000) + "'\n# \x03\r\x04",
      undefined,
      token,
    );
    expect(input.slice(0, -1)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
    expect(
      Math.max(...input.split("\n").map((line) => Buffer.byteLength(line))),
    ).toBeLessThan(1400);
    expect(run("printf '%s' '" + "x".repeat(20000) + "'")).toContain(
      "x".repeat(20000),
    );
  });
});
