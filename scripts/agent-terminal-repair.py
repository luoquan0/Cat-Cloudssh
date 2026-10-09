from pathlib import Path


def replace(name, before, after):
    path = Path(name)
    source = path.read_text()
    if after in source:
        return
    if source.count(before) != 1:
        raise RuntimeError(f'{name}: expected one anchor, found {source.count(before)}: {before[:90]}')
    path.write_text(source.replace(before, after))


def write(name, content):
    path = Path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


write('src/backend/panel-runtime/shared-terminal-command.ts', r'''const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

/** Only ASCII octal data crosses the terminal line discipline. Physical lines
 * stay short: long scripts, CR, Ctrl-C and heredocs cannot become parent input. */
export function buildSharedTerminalCommand(
  command: string,
  cwd: string | undefined,
  token: string,
): string {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error("Invalid command frame token");
  const script = cwd ? `cd -- ${quote(cwd)} &&\n${command}` : command;
  const encoded = Array.from(Buffer.from(script, "utf8"), (byte) =>
    `\\0${byte.toString(8).padStart(3, "0")}`,
  ).join("");
  const argument = (encoded.match(/.{1,640}/g) || [""])
    .map(quote).join("\\\n");
  const tty = `__cloudssh_tty_${token}`;
  const status = `__cloudssh_status_${token}`;
  return `command printf '\\033]777;cloudssh-agent-begin=${token}\\007'; ` +
    `${tty}=$(command stty -g 2>/dev/null) || :; ` +
    `if command sh -c "$(command printf '%b' ${argument})" </dev/null; ` +
    `then ${status}=0; else ${status}=$?; fi; ` +
    `if [ -n "$${tty}" ]; then command stty "$${tty}" 2>/dev/null || :; fi; ` +
    `command printf '\\033]777;cloudssh-agent-end=${token};status=%s\\007' "$${status}"; ` +
    `unset ${tty} ${status}\r`;
}
''')

write('src/backend/panel-runtime/shared-terminal-command.test.ts', r'''import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildSharedTerminalCommand } from "./shared-terminal-command.js";

const token = "0123456789abcdef0123456789abcdef";
function run(command: string, cwd?: string) {
  const wrapper = buildSharedTerminalCommand(command, cwd, token);
  // A persistent parent is used, not a fresh shell per tool invocation.
  const input = "export CLOUDSSH_PARENT_TEST=kept\n" + wrapper.replace(/\r$/, "\n") +
    "printf '\\nPARENT_ALIVE:%s:%s\\n' \"$CLOUDSSH_PARENT_TEST\" \"$PWD\"\n";
  const child = spawnSync("/bin/sh", [], { input, encoding: "utf8", timeout: 5000 });
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
    expect(run(String(command))).toContain(`cloudssh-agent-end=${token};status=${status}\x07`);
  });
  it("inherits cwd and exported environment without changing the parent", () => {
    const output = run("printf '%s:%s' \"$PWD\" \"$CLOUDSSH_PARENT_TEST\"; export CLOUDSSH_PARENT_TEST=changed", "/tmp");
    expect(output).toContain("/tmp:kept");
    expect(output).toContain("PARENT_ALIVE:kept:");
  });
  it("preserves unicode, quotes, multiline scripts and heredocs", () => {
    expect(run("cat <<'EOF'\n中文 'quoted' $literal\nEOF\n")).toContain("中文 'quoted' $literal\n");
  });
  it("never places raw terminal control bytes or oversized lines in PTY input", () => {
    const input = buildSharedTerminalCommand("printf '" + "x".repeat(20000) + "'\n# \x03\r\x04", undefined, token);
    expect(input.slice(0, -1)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
    expect(Math.max(...input.split("\n").map((line) => Buffer.byteLength(line)))).toBeLessThan(1400);
    expect(run("printf '%s' '" + "x".repeat(20000) + "'")).toContain("x".repeat(20000));
  });
});
''')

write('src/ui/features/terminal/agent-trace-formatter.ts', r'''/** A display-only stream. Never return this text to the SSH input channel. */
export class AgentTraceFormatter {
  private escape: "text" | "esc" | "csi" | "osc" | "osc-esc" = "text";
  private afterCR = false;
  private currentJob = "";

  private text(value: string): string {
    let output = "";
    for (const char of value) {
      if (this.escape === "osc") {
        if (char === "\x07") this.escape = "text";
        else if (char === "\x1b") this.escape = "osc-esc";
        continue;
      }
      if (this.escape === "osc-esc") {
        this.escape = char === "\\" ? "text" : "osc";
        continue;
      }
      if (this.escape === "csi") {
        if (char >= "@" && char <= "~") this.escape = "text";
        continue;
      }
      if (this.escape === "esc") {
        this.escape = char === "[" ? "csi" : char === "]" || char === "P" || char === "_" || char === "^" ? "osc" : "text";
        continue;
      }
      if (char === "\x1b") { this.escape = "esc"; continue; }
      if (char === "\r") { output += "\r\n"; this.afterCR = true; continue; }
      if (char === "\n") {
        if (!this.afterCR) output += "\r\n";
        this.afterCR = false;
        continue;
      }
      this.afterCR = false;
      if (char === "\t" || (char >= " " && char !== "\x7f" && !(char >= "\x80" && char <= "\x9f"))) output += char;
    }
    return output;
  }

  format(message: { phase?: unknown; command?: unknown; data?: unknown; status?: unknown; exitCode?: unknown; jobId?: unknown }): string {
    const phase = String(message.phase || "");
    const jobId = typeof message.jobId === "string" ? message.jobId : "";
    const label = jobId ? `[Agent ${jobId.slice(0, 8)}]` : "[Agent]";
    if (phase === "start") {
      this.escape = "text";
      this.afterCR = false;
      this.currentJob = jobId;
      const command = this.text(String(message.command || "")).replace(/\r\n/g, "\r\n    ");
      this.afterCR = false;
      return `\r\n${label} $ ${command}\r\n`;
    }
    if (phase === "stdout" || phase === "stderr") {
      let prefix = "";
      if (jobId && jobId !== this.currentJob) {
        this.escape = "text";
        this.afterCR = false;
        this.currentJob = jobId;
        prefix = `\r\n${label}\r\n`;
      }
      return prefix + this.text(String(message.data || ""));
    }
    if (phase === "end") {
      this.escape = "text";
      this.afterCR = false;
      const status = this.text(String(message.status || "done"));
      const exit = typeof message.exitCode === "number" ? ` · exit ${message.exitCode}` : "";
      return `\r\n${label} ${status}${exit}\r\n`;
    }
    return "";
  }
}
''')

write('src/ui/tests/agent-trace-formatter.test.ts', r'''import { describe, expect, it } from "vitest";
import { AgentTraceFormatter } from "@/features/terminal/agent-trace-formatter";

describe("display-only Agent terminal traces", () => {
  it("normalizes LF without adding duplicate CRLF across chunk boundaries", () => {
    const f = new AgentTraceFormatter();
    const output = ["one\n", "two\r", "\nthree\nfour\r", "five"].map(data => f.format({ phase: "stdout", data })).join("");
    expect(output).toBe("one\r\ntwo\r\nthree\r\nfour\r\nfive");
  });
  it("preserves multiline commands rather than flattening heredocs", () => {
    expect(new AgentTraceFormatter().format({ phase: "start", command: "cat <<'EOF'\nhello\nEOF" })).toContain("cat <<'EOF'\r\n    hello\r\n    EOF");
  });
  it("does not let cursor commands or split OSC overwrite the human terminal", () => {
    const f = new AgentTraceFormatter();
    const parts = ["A\x1b[", "2JB\x1b]52;c;secret", "\x07C\n"];
    expect(parts.map(data => f.format({phase: "stdout", data})).join("")).toBe("ABC\r\n");
  });
});
''')

jobs = 'src/backend/panel-runtime/jobs.ts'
replace(jobs, 'import crypto from "node:crypto";', 'import crypto from "node:crypto";\nimport { StringDecoder } from "node:string_decoder";\nimport { buildSharedTerminalCommand } from "./shared-terminal-command.js";')
replace(jobs, '  private live = new Map<string, LiveJob>();', '  private live = new Map<string, LiveJob>();\n  private sharedRecoveryRequired = new Set<string>();')
replace(jobs, '    const leaseId = `panel-agent-${job.id}`;', '''    requireValue(!this.sharedRecoveryRequired.has(sessionId), 409,
      "SHARED_TERMINAL_RECOVERY_REQUIRED",
      "上次共享命令中断后未收到 Shell 结束标记。请人工核对，关闭该终端并建立新 SSH，或改用独立执行；不会自动重放命令。");
    const leaseId = `panel-agent-${job.id}`;''')
replace(jobs, '        let carry = "";\n        let abortTimer:', '        let carry = "";\n        const decoder = new StringDecoder("utf8");\n        let abortTimer:')
replace(jobs, 'carry + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk)', 'carry + (Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk)')
source = Path(jobs).read_text()
start = source.find('        const command = job.cwd\n')
end = source.find('        try {\n          stream.write(wrapper);', start)
if 'const wrapper = buildSharedTerminalCommand(job.command, job.cwd, token);' not in source:
    if start < 0 or end < start: raise RuntimeError('shared wrapper anchors missing')
    source = source[:start] + '        const wrapper = buildSharedTerminalCommand(job.command, job.cwd, token);\n' + source[end:]
    Path(jobs).write_text(source)
replace(jobs, '        const abort = () => {\n          try {\n            stream.write("\\u0003");', '        const abort = () => {\n          if (settled || abortTimer) return;\n          try {\n            stream.write("\\u0003");')
replace(jobs, '''      clearTimeout(timer);
      sessionManager.releaseAgentRuntimeLease(sessionId, leaseId);''', '''      clearTimeout(timer);
      if (job.exitCode === null) {
        const session = sessionManager.getSession(sessionId);
        if (session?.isConnected && session.sshStream) {
          this.sharedRecoveryRequired.add(sessionId);
          session.sshStream.once("close", () => this.sharedRecoveryRequired.delete(sessionId));
        }
      }
      sessionManager.releaseAgentRuntimeLease(sessionId, leaseId);''')
# Streaming UTF-8 for mirrored output: do not decode each arbitrary SSH Buffer.
replace(jobs, '''    mirror = false,
  ) {
    const signal = controller.signal;''', '''    mirror = false,
  ) {
    const signal = controller.signal;
    const traceDecoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };''')
replace(jobs, 'data: data.toString("utf8"),\n                shared: false,', 'data: traceDecoders[kind].write(data),\n                jobId: job.id,\n                shared: false,')
# Add job IDs to every start/end trace for concurrent-run attribution.
source = Path(jobs).read_text()
source = source.replace('phase: "start",\n        command:', 'phase: "start",\n        jobId: job.id,\n        command:')
source = source.replace('phase: "end",\n        status:', 'phase: "end",\n        jobId: job.id,\n        status:')
source = source.replace('phase: "end",\n          status:', 'phase: "end",\n          jobId: job.id,\n          status:')
# Flush any final decoder bytes before the end-of-job marker.
anchor = '      if (mirror) {\n        this.terminalTrace(owner, target, {\n          phase: "end",'
if 'const tail = traceDecoders[kind].end();' not in source:
    if source.count(anchor) != 1: raise RuntimeError('mirror finish anchor')
    source = source.replace(anchor, '''      if (mirror) {
        for (const kind of ["stdout", "stderr"] as const) {
          const tail = traceDecoders[kind].end();
          if (tail) this.terminalTrace(owner, target, { phase: kind, data: tail, jobId: job.id, shared: false });
        }
        this.terminalTrace(owner, target, {
          phase: "end",''')
Path(jobs).write_text(source)

terminal = 'src/ui/features/terminal/Terminal.tsx'
source = Path(terminal).read_text()
if 'import { AgentTraceFormatter }' not in source:
    source = 'import { AgentTraceFormatter } from "./agent-trace-formatter";\n' + source
if 'const panelAgentTraceRef =' not in source:
    anchor = '  const panelAgentInputBlockedRef'
    if source.count(anchor) != 1: raise RuntimeError('terminal trace state anchor')
    source = source.replace(anchor, '  const panelAgentTraceRef = useRef(new AgentTraceFormatter());\n' + anchor)
start = source.index('          } else if (msg.type === "agentTrace") {')
end = source.index('          } else if (msg.type === "agentControlState") {', start)
source = source[:start] + '''          } else if (msg.type === "agentTrace") {
            const display = panelAgentTraceRef.current.format(msg);
            if (display) terminal.write(display);
''' + source[end:]
Path(terminal).write_text(source)

replace('src/backend/panel-runtime/jobs.test.ts', 'expect(channel.writes.join("")).toContain("eval \'pwd\'");', 'expect(channel.writes.join("")).toContain("command sh -c");\n    expect(channel.writes.join("")).not.toContain("eval \'pwd\'");')

# Keep the contract honest: same PTY and inherited cwd/exported env, not eval in
# the human login shell. Existing saved mode IDs remain compatible.
panel = Path('src/ui/sidebar/PanelAgentPanel.tsx')
text = panel.read_text()
text = text.replace('与一个已连接终端共享同一 shell、cwd 和环境变量。', '共享终端显示，继承当前目录与已导出环境；命令在子 Shell 执行，不改变或退出你的主 Shell。')
panel.write_text(text)

# Avoid dropping the last captured text when cancelling a shared command.
manager = 'src/backend/hosts/terminal/session-manager.ts'
replace(manager, '''    if (!session || session.agentRuntimeLeaseId !== leaseId) return false;
    session.agentRuntimeLeaseId = null;''', '''    if (!session || session.agentRuntimeLeaseId !== leaseId) return false;
    if (session.agentRuntimeOutputState === "capturing" && session.agentRuntimeOutputCarry) {
      const carry = session.agentRuntimeOutputCarry;
      const marker = carry.indexOf("\\u001b]777;cloudssh-agent-");
      const tail = marker >= 0 ? carry.slice(0, marker) : carry;
      if (tail) {
        this.bufferOutput(sessionId, tail);
        this.broadcast(sessionId, { type: "data", data: tail });
      }
    }
    session.agentRuntimeLeaseId = null;''')
print('Prepared terminal stability changes')
