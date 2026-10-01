import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import type { PanelAgentChatMessage } from "@/api/panel-agent-api";
import { runtimeApi, type JobOutput } from "@/api/panel-runtime-api";
import { Button } from "@/components/button";

export function RuntimeToolCard({ message }: { message: PanelAgentChatMessage }) {
  const [open, setOpen] = useState(false);
  const [output, setOutput] = useState<JobOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  let payload: Record<string, unknown> = {};
  try { const value = JSON.parse(message.content); if (value && typeof value === "object") payload = value; } catch { /* Legacy text is still readable. */ }
  const status = String(output?.status || payload.status || "recorded");
  const label = ({ starting: "正在连接", running: "运行中", completed: "已完成", failed: "执行失败", interrupted: "结果待核对", timed_out: "执行超时", cancelled: "已请求停止", output_limit: "日志存储保护", blocked: "未执行" } as Record<string, string>)[status] || "工具记录";
  const jobId = typeof payload.jobId === "string" ? payload.jobId : null;
  async function load(tail = false, next = false) {
    if (!jobId || loading) return;
    setLoading(true); setError("");
    try { setOutput(await runtimeApi.output(jobId, { tail, ...(next && output ? { stdoutOffset: output.nextStdoutOffset, stderrOffset: output.nextStderrOffset } : {}) })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "无法读取日志"); }
    finally { setLoading(false); }
  }
  const preview = output ? [output.stdout, output.stderr].filter(Boolean).join("\n[stderr]\n") : [payload.stdout, payload.stderr, payload.recentOutput].filter(value => typeof value === "string").join("\n");
  return <div className="rounded-xl border border-border/60 bg-muted/25 text-[11px]">
    <button type="button" aria-expanded={open} className="flex w-full min-w-0 items-center gap-2 p-2 text-left text-muted-foreground" onClick={() => setOpen(value => !value)}>
      {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
      <Wrench className="size-3 shrink-0" /><span>{label}</span>
      <span className="min-w-0 flex-1 truncate">{String(payload.command || message.name || "")}</span>
      {typeof payload.exitCode === "number" && <span>exit {payload.exitCode}</span>}
    </button>
    {open && <div className="space-y-2 border-t border-border/40 p-2">
      {typeof payload.command === "string" && <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all">{payload.command}</pre>}
      {Boolean(payload.error) && <p className="break-words text-amber-600">{String(payload.error)}</p>}
      {preview && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background/60 p-2">{preview}</pre>}
      {payload.contextExcerpt === true && <p className="text-muted-foreground">模型只使用了上下文预算内的片段，原始输出保留在任务日志中。</p>}
      {jobId && <div className="flex flex-wrap gap-1">
        <Button size="xs" variant="ghost" disabled={loading} onClick={() => void load()}>读取日志开头</Button>
        <Button size="xs" variant="ghost" disabled={loading} onClick={() => void load(true)}>读取日志末尾</Button>
        {output?.hasMore && <Button size="xs" variant="ghost" disabled={loading} onClick={() => void load(false, true)}>下一页</Button>}
      </div>}
      {error && <p role="alert" className="text-amber-600">{error}</p>}
    </div>}
  </div>;
}
