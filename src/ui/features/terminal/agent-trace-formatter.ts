/** A display-only stream. Never return this text to the SSH input channel. */
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
        this.escape =
          char === "["
            ? "csi"
            : char === "]" || char === "P" || char === "_" || char === "^"
              ? "osc"
              : "text";
        continue;
      }
      if (char === "\x1b") {
        this.escape = "esc";
        continue;
      }
      if (char === "\r") {
        output += "\r\n";
        this.afterCR = true;
        continue;
      }
      if (char === "\n") {
        if (!this.afterCR) output += "\r\n";
        this.afterCR = false;
        continue;
      }
      this.afterCR = false;
      if (
        char === "\t" ||
        (char >= " " && char !== "\x7f" && !(char >= "\x80" && char <= "\x9f"))
      )
        output += char;
    }
    return output;
  }

  format(message: {
    phase?: unknown;
    command?: unknown;
    data?: unknown;
    status?: unknown;
    exitCode?: unknown;
    jobId?: unknown;
  }): string {
    const phase = String(message.phase || "");
    const jobId = typeof message.jobId === "string" ? message.jobId : "";
    const label = jobId ? `[Agent ${jobId.slice(0, 8)}]` : "[Agent]";
    if (phase === "start") {
      this.escape = "text";
      this.afterCR = false;
      this.currentJob = jobId;
      const command = this.text(String(message.command || "")).replace(
        /\r\n/g,
        "\r\n    ",
      );
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
      const exit =
        typeof message.exitCode === "number"
          ? ` · exit ${message.exitCode}`
          : "";
      return `\r\n${label} ${status}${exit}\r\n`;
    }
    return "";
  }
}
