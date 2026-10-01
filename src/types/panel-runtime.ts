// Transport-neutral runtime DTOs. Model calls use standard Chat Completions tools.
export type RuntimeToolName = "run_command" | "read_job_output" | "cancel_job";
export type RuntimeToolCall = { id: string; name: RuntimeToolName; arguments: Record<string, unknown> };
export type RuntimeAttachment = { id: string; name: string; mimeType: string; size: number; kind: "image" | "text" | "file"; dataUrl?: string; text?: string };
export type RuntimeMessage = {
  id: string;
  seq?: number;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: RuntimeToolCall[];
  attachments?: RuntimeAttachment[];
};
export type RuntimeTarget = { targetId: string; hostId: number; hostName: string; projectHostId?: number };
export type RuntimeOptions = { model?: string; reasoningEffort?: "auto" | "low" | "medium" | "high"; skillIds?: string[] };
export type RuntimeStatus = "queued" | "running" | "compacting" | "waiting_approval" | "paused" | "completed" | "cancelled" | "interrupted" | "failed";
export type RuntimeThread = { id: string; title: string; lastSeq: number; summary: string; summarySeq: number; updatedAt: number };
export type RuntimeRun = {
  id: string;
  threadId: string;
  status: RuntimeStatus;
  userSeq: number;
  targets: RuntimeTarget[];
  options: RuntimeOptions;
  pending: RuntimeToolCall[];
  error: string | null;
  updatedAt: number;
  contextTokens: number;
  contextWindow: number;
};
export type RuntimeJobStatus = "starting" | "running" | "completed" | "failed" | "cancelled" | "timed_out" | "interrupted" | "output_limit";
export type RuntimeJob = {
  id: string;
  runId: string;
  toolCallId: string;
  targetId: string;
  hostId: number;
  command: string;
  cwd?: string;
  status: RuntimeJobStatus;
  exitCode: number | null;
  signal: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};
export type RuntimeSnapshot = { run: RuntimeRun | null; thread: RuntimeThread; messages: RuntimeMessage[]; hasMore: boolean; nextAfter: number };
export type StartRuntimeInput = {
  requestId: string;
  threadId?: string;
  expectedSeq?: number;
  message: RuntimeMessage;
  // Explicit one-time migration of the currently displayed legacy chat only.
  history?: RuntimeMessage[];
  targets: RuntimeTarget[];
  options: RuntimeOptions;
};
export const runtimeIsActive = (status: RuntimeStatus) => ["queued", "running", "compacting", "waiting_approval"].includes(status);
