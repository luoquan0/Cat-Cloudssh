import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeToolCall } from "../../types/panel-runtime.js";

/** A conservative convenience allowlist, NOT a shell sandbox or a proof of safety. */
export function needsApproval(call: RuntimeToolCall): boolean {
  if (call.name !== "run_command") return false;
  if (call.arguments.risk === "high") return true;
  const command = String(call.arguments.command ?? "").trim();
  if (!command || /[\n\r;&|<>$`\\(){}[\]*?!'"]/.test(command)) return true;
  const words = command.split(/\s+/);
  const executable = words[0];
  if (executable.includes("/") || words.some((word) => /^\/dev\//.test(word)))
    return true;
  // hostname/date/uname can modify state with certain flags or positional args.
  if (["pwd", "whoami", "hostname", "date"].includes(executable))
    return words.length !== 1;
  if (executable === "uname")
    return !words.slice(1).every((word) => /^-[asnrvmpio]+$/.test(word));
  if (
    [
      "uptime",
      "df",
      "free",
      "ps",
      "ls",
      "stat",
      "cat",
      "head",
      "wc",
      "grep",
    ].includes(executable)
  )
    return false;
  if (executable === "tail")
    return words.some((word) => /^-(?:[^-]*[fF]|-follow)/.test(word));
  if (
    executable === "docker" &&
    ["ps", "images", "version", "info", "inspect", "logs"].includes(words[1])
  ) {
    return words.some((word) => word === "--follow" || word === "-f");
  }
  if (
    executable === "systemctl" &&
    ["status", "show", "is-active", "is-enabled"].includes(words[1])
  )
    return false;
  return true;
}

export class ProgressWatchdog {
  private recent: string[] = [];
  private lastRequest = 0;
  constructor(
    private threshold = 5,
    private requestSpacingMs = 1000,
  ) {}
  observe(call: RuntimeToolCall, result: Record<string, unknown>): boolean {
    // Waiting on a real background job is not a loop failure. Its own deadline
    // and cancellation remain enforced by the execution layer.
    if (
      call.name === "read_job_output" &&
      ["starting", "running"].includes(String(result.status))
    ) {
      this.recent = [];
      return false;
    }
    const meaningful = {
      name: call.name,
      targetId: call.arguments.targetId,
      command: call.arguments.command,
      jobId: call.name === "cancel_job" ? call.arguments.jobId : undefined,
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
    };
    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(meaningful))
      .digest("hex");
    this.recent.push(hash);
    this.recent = this.recent.slice(-this.threshold * 4);
    for (let width = 1; width <= 4; width += 1) {
      if (this.recent.length < this.threshold * width) continue;
      const tail = this.recent.slice(-this.threshold * width);
      if (tail.every((item, index) => item === tail[index % width]))
        return true;
    }
    return false;
  }
  async beforeModel(signal: AbortSignal) {
    const wait = this.lastRequest + this.requestSpacingMs - Date.now();
    if (wait > 0) await delay(wait, undefined, { signal });
    signal.throwIfAborted();
    this.lastRequest = Date.now();
  }
}

export function redactEvidence(text: string): string {
  return text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\b(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(
      /\b(password|passwd|token|api[_-]?key|secret)(\s*[=:]\s*)[^\s]+/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}
