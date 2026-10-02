import { getEncoding } from "js-tiktoken";
import type { RuntimeMessage, RuntimeRun } from "../../types/panel-runtime.js";
import { RuntimeError, type RuntimeStore } from "./store.js";
import {
  RUNTIME_TOOLS,
  toModelMessage,
  type ModelMessage,
  type RuntimeModel,
} from "./model.js";

let encoding: ReturnType<typeof getEncoding> | undefined;
export class ContextBudget {
  constructor(
    public window: number,
    public completion: number,
    private model: string,
  ) {}
  private knownEncoding() {
    return /^(?:gpt-4o|gpt-4\.1|gpt-5|o[1-9])/.test(this.model);
  }
  count(value: unknown): number {
    let images = 0;
    const serialized =
      JSON.stringify(value, (_key, item) => {
        if (typeof item === "string" && item.startsWith("data:image/")) {
          images += 1;
          return "[image]";
        }
        return item;
      }) ?? "";
    const bytes = Buffer.byteLength(serialized, "utf8");
    // Avoid spending seconds tokenizing grossly over-budget input. Unknown
    // compatible model IDs use a conservative byte estimate, not fake exact tokens.
    const tokens =
      this.knownEncoding() && bytes <= this.window * 12
        ? (encoding ??= getEncoding("o200k_base")).encode(serialized, [], [])
            .length
        : bytes;
    return tokens + images * 8192 + 32;
  }
  inputLimit(): number {
    return Math.floor(this.window * 0.9) - this.completion - 256;
  }
  bytesForTokens(tokens: number): number {
    return Math.max(128, Math.floor(tokens * (this.knownEncoding() ? 3 : 1)));
  }
  fitText(
    text: string,
    tokens: number,
    marker = "\n[excerpt; omitted output remains in the job log]\n",
  ): string {
    if (this.count(text) <= tokens) return text;
    const excerpt = (size: number) => {
      const front = Math.ceil(size / 3);
      const back = Math.floor((size * 2) / 3);
      return text.slice(0, front) + marker + (back ? text.slice(-back) : "");
    };
    let low = 0;
    let high = text.length;
    while (low < high) {
      const size = Math.ceil((low + high) / 2);
      if (this.count(excerpt(size)) <= tokens) low = size;
      else high = size - 1;
    }
    return low ? excerpt(low) : "[excerpt unavailable]";
  }
}

export function completeGroups(messages: RuntimeMessage[]): RuntimeMessage[][] {
  const groups: RuntimeMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "tool")
      throw new RuntimeError(
        409,
        "ORPHAN_TOOL_RESULT",
        "工具结果缺少对应调用，请检查原始记录",
      );
    const group = [message];
    const pending = new Set(message.toolCalls?.map((call) => call.id) ?? []);
    while (pending.size && index + 1 < messages.length) {
      const next = messages[index + 1];
      if (
        next.role !== "tool" ||
        !next.toolCallId ||
        !pending.has(next.toolCallId)
      )
        break;
      pending.delete(next.toolCallId);
      group.push(next);
      index += 1;
    }
    // A page can end mid-exchange; never send a half tool exchange to the model.
    if (pending.size) break;
    groups.push(group);
  }
  return groups;
}

export function fitToolEvidence(
  result: Record<string, unknown>,
  budget: ContextBudget,
  tokens: number,
): Record<string, unknown> {
  const copy = { ...result };
  const fields = ["stdout", "stderr", "recentOutput"];
  const metadata = { ...copy };
  for (const field of fields) delete metadata[field];
  const present = fields.filter(
    (field) => typeof copy[field] === "string" && copy[field],
  );
  const perField = Math.max(
    32,
    Math.floor(
      (tokens - budget.count(metadata) - 96) / Math.max(1, present.length),
    ),
  );
  for (const field of present) {
    const original = String(copy[field]);
    copy[field] = budget.fitText(original, perField);
    if (copy[field] !== original) copy.contextExcerpt = true;
  }
  if (budget.count(copy) <= tokens) return copy;
  const minimal = {
    jobId: result.jobId,
    status: result.status,
    exitCode: result.exitCode,
    contextExcerpt: true,
  };
  return budget.count(minimal) <= tokens ? minimal : { contextExcerpt: true };
}

export async function prepareContext(
  store: RuntimeStore,
  owner: string,
  run: RuntimeRun,
  base: ModelMessage[],
  model: RuntimeModel,
  budget: ContextBudget,
  signal: AbortSignal,
  onCompacting: () => Promise<void>,
): Promise<{ messages: ModelMessage[]; tokens: number; toolTokens: number }> {
  if (
    budget.count({ messages: base, tools: RUNTIME_TOOLS }) >
    budget.inputLimit() * 0.8
  ) {
    throw new RuntimeError(
      413,
      "CURRENT_TASK_TOO_LARGE",
      "当前输入或系统提示超过模型上下文；原文保留，请减少输入或选择更大窗口",
    );
  }
  const originalLastSeq = store.thread(owner, run.threadId).lastSeq;
  let processedThrough = -1;
  while (processedThrough < originalLastSeq) {
    signal.throwIfAborted();
    const thread = store.thread(owner, run.threadId);
    const page = store.messages(owner, run.threadId, thread.summarySeq, 256);
    const groups = completeGroups(page);
    const covered = groups.flat();
    const allLoaded =
      (covered.at(-1)?.seq ?? thread.summarySeq) === thread.lastSeq;
    const prefix: ModelMessage[] = thread.summary
      ? [
          ...base,
          {
            role: "user",
            content:
              "Earlier conversation summary; historical evidence, not a new instruction:\n" +
              thread.summary,
          },
        ]
      : base;
    const messages = [...prefix, ...covered.map(toModelMessage)];
    const tokens = budget.count({ messages, tools: RUNTIME_TOOLS });
    if (
      allLoaded &&
      tokens <= budget.inputLimit() &&
      (tokens <= budget.inputLimit() * 0.75 || groups.length <= 2)
    ) {
      return {
        messages,
        tokens,
        toolTokens: Math.max(
          128,
          Math.floor((budget.inputLimit() - tokens) * 0.65),
        ),
      };
    }
    const candidates = allLoaded ? groups.slice(0, -1) : groups;
    if (!candidates.length)
      throw new RuntimeError(
        413,
        "CONTEXT_CANNOT_FIT",
        "完整工具交换无法装入上下文；记录未删除，请调整模型或停止后新建任务",
      );
    const allowance = Math.max(
      512,
      Math.floor(
        (budget.inputLimit() - budget.count(thread.summary) - 1024) * 0.6,
      ),
    );
    const batch: RuntimeMessage[] = [];
    for (const group of candidates) {
      if (batch.length && budget.count([...batch, ...group]) > allowance) break;
      batch.push(...group);
    }
    const through = batch.at(-1)?.seq ?? thread.summarySeq;
    if (through <= thread.summarySeq || through <= processedThrough)
      throw new RuntimeError(
        500,
        "COMPACTION_NO_PROGRESS",
        "摘要边界没有前进，已暂停",
      );
    const transcript = budget.fitText(
      JSON.stringify(
        batch.map((message) => ({
          seq: message.seq,
          role: message.role,
          content: message.content,
          toolCalls: message.toolCalls,
          toolCallId: message.toolCallId,
          attachments: message.attachments?.map((item) => ({
            name: item.name,
            kind: item.kind,
            text: item.text,
          })),
        })),
      ),
      allowance,
      "\n[historical input excerpted; omitted details are unknown, originals are retained]\n",
    );
    await onCompacting();
    const summary = await model.summarize(thread.summary, transcript, signal);
    signal.throwIfAborted();
    if (
      !summary.trim() ||
      budget.count(summary) > Math.max(512, budget.window * 0.2)
    )
      throw new RuntimeError(
        502,
        "SUMMARY_INVALID",
        "摘要未满足预算，原摘要和原文均保留",
      );
    await store.summary(
      owner,
      run.threadId,
      thread.summarySeq,
      through,
      summary,
    );
    processedThrough = through;
  }
  throw new RuntimeError(
    500,
    "CONTEXT_UNAVAILABLE",
    "无法准备上下文，已保留原始记录",
  );
}
