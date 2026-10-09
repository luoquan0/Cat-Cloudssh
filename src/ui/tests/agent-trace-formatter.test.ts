import { describe, expect, it } from "vitest";
import { AgentTraceFormatter } from "@/features/terminal/agent-trace-formatter";

describe("display-only Agent terminal traces", () => {
  it("normalizes LF without adding duplicate CRLF across chunk boundaries", () => {
    const f = new AgentTraceFormatter();
    const output = ["one\n", "two\r", "\nthree\nfour\r", "five"]
      .map((data) => f.format({ phase: "stdout", data }))
      .join("");
    expect(output).toBe("one\r\ntwo\r\nthree\r\nfour\r\nfive");
  });
  it("preserves multiline commands rather than flattening heredocs", () => {
    expect(
      new AgentTraceFormatter().format({
        phase: "start",
        command: "cat <<'EOF'\nhello\nEOF",
      }),
    ).toContain("cat <<'EOF'\r\n    hello\r\n    EOF");
  });
  it("does not let cursor commands or split OSC overwrite the human terminal", () => {
    const f = new AgentTraceFormatter();
    const parts = ["A\x1b[", "2JB\x1b]52;c;secret", "\x07C\n"];
    expect(
      parts.map((data) => f.format({ phase: "stdout", data })).join(""),
    ).toBe("ABC\r\n");
  });
});
