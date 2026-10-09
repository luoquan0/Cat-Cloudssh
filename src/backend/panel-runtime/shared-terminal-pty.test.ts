import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildSharedTerminalCommand } from "./shared-terminal-command.js";

describe("real shared PTY regression", () => {
  it.skipIf(process.platform !== "linux")(
    "keeps a single interactive parent alive across hostile shell lifecycle commands",
    () => {
      const commands: Array<[string, number]> = [
        ["exit 7", 7],
        ["exec printf child-exec", 0],
        ["set -e; false", 1],
        ["cat", 0],
        ["read answer", 1],
        ["printf '%s' '" + "x".repeat(20000) + "'", 0],
        ["cat <<'EOF'\n中文 'quoted' $literal\nEOF", 0],
        ["stty raw -echo </dev/tty; exit 2", 2],
      ];
      const cases = commands.map(([command, status], index) => {
        const token = index.toString(16).padStart(32, "0");
        return {
          token,
          status,
          wrapper: buildSharedTerminalCommand(command, undefined, token),
        };
      });
      const result = spawnSync(
        "python3",
        ["scripts/shared-terminal-pty-check.py"],
        {
          input: JSON.stringify(cases),
          encoding: "utf8",
          timeout: 30000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(
        commands.map(([, status]) => ({ status, parentAlive: true })),
      );
    },
    35000,
  );
});
