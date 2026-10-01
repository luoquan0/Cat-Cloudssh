import crypto from "node:crypto";
import { getHeapStatistics } from "node:v8";
import type { RuntimeMessage, RuntimeRun, RuntimeToolCall, StartRuntimeInput } from "../../types/panel-runtime.js";
import { RuntimeStore, RuntimeError, requireValue } from "./store.js";
import { RuntimeJobs, positiveSetting } from "./jobs.js";
import { ContextBudget, fitToolEvidence, prepareContext } from "./context.js";
import { basePrompt, ContextOverflowError, OpenAIRuntimeModel, type RuntimeModel, type RuntimeModelConfig } from "./model.js";
import { needsApproval, ProgressWatchdog, redactEvidence } from "./policy.js";

type Authorization = () => Promise<void>;
type Execution = { owner: string; controller: AbortController; done: Promise<void>; approval: ((approved: boolean) => void) | null };
export type RuntimeDependencies = {
  config: () => Promise<RuntimeModelConfig>;
  model?: (config: RuntimeModelConfig, run: RuntimeRun) => RuntimeModel;
};

export class PanelRuntime {
  private executions = new Map<string, Execution>();
  private initialized: Promise<void> | null = null;
  constructor(readonly store: RuntimeStore, readonly jobs: RuntimeJobs, private dependencies: RuntimeDependencies) {}
  async initialize() { this.initialized ??= this.store.recoverInterrupted(); await this.initialized; }
  async start(owner: string, input: StartRuntimeInput, authorize: Authorization) {
    await this.initialize();
    await authorize();
    requireValue(this.executions.size < positiveSetting("PANEL_AGENT_CONCURRENT_RUNS", 8), 429, "RUNTIME_BUSY", "Agent 执行资源忙，请稍后重试");
    const { run } = await this.store.start(owner, input);
    if (run.status === "queued" && !this.executions.has(run.id)) this.launch(owner, run, authorize);
    return run;
  }
  private launch(owner: string, run: RuntimeRun, authorize: Authorization) {
    const execution: Execution = { owner, controller: new AbortController(), done: Promise.resolve(), approval: null };
    this.executions.set(run.id, execution);
    execution.done = this.loop(owner, run, execution, authorize).finally(() => this.executions.delete(run.id));
    // Requests return immediately; this promise is always observed independently of the browser.
    void execution.done.catch(() => {});
  }
  private async finishPending(owner: string, run: RuntimeRun, reason: string) {
    const messages: RuntimeMessage[] = run.pending.map(call => ({ id: crypto.randomUUID(), role: "tool", name: call.name, toolCallId: call.id, content: JSON.stringify({ status: "interrupted", error: reason, instruction: "Inspect existing job state before retrying. This is not confirmation that a remote command did or did not run." }) }));
    run.pending = [];
    await this.store.saveRun(owner, run, messages);
  }
  async resume(owner: string, id: string, authorize: Authorization) {
    await this.initialize();
    const run = this.store.run(owner, id);
    requireValue(!this.executions.has(id) && ["paused", "interrupted", "failed"].includes(run.status), 409, "RUN_NOT_PAUSED", "该任务不能重复启动");
    await authorize();
    await this.finishPending(owner, run, "Previous execution was interrupted or paused; do not replay unknown mutations.");
    run.status = "queued";
    run.error = null;
    await this.store.saveRun(owner, run);
    this.launch(owner, run, authorize);
    return run;
  }
  async approve(owner: string, id: string, toolCallId: string, approved: boolean, authorize: Authorization) {
    const run = this.store.run(owner, id);
    const execution = this.executions.get(id);
    requireValue(run.status === "waiting_approval" && run.pending[0]?.id === toolCallId && execution?.owner === owner && execution.approval, 409, "APPROVAL_CHANGED", "待确认命令已变化，请刷新后核对");
    await authorize();
    const resolve = execution.approval;
    execution.approval = null;
    resolve(approved);
  }
  async cancel(owner: string, id: string) {
    const run = this.store.run(owner, id);
    const execution = this.executions.get(id);
    if (execution) {
      requireValue(execution.owner === owner, 403, "RUN_OWNER", "无权停止该任务");
      execution.controller.abort(new Error("用户停止任务"));
      await execution.done;
    } else if (!["completed", "cancelled"].includes(run.status)) {
      run.status = "cancelled";
      await this.finishPending(owner, run, "Task was cancelled; verify remote state before repeating work.");
    }
    return this.store.run(owner, id);
  }
  private async waitApproval(owner: string, run: RuntimeRun, execution: Execution) {
    run.status = "waiting_approval";
    await this.store.saveRun(owner, run);
    return new Promise<boolean>((resolve, reject) => {
      const signal = execution.controller.signal;
      const abort = () => { execution.approval = null; reject(signal.reason); };
      execution.approval = value => { signal.removeEventListener("abort", abort); execution.approval = null; resolve(value); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  private async perform(owner: string, run: RuntimeRun, call: RuntimeToolCall, signal: AbortSignal, tokens: number, approved: boolean): Promise<Record<string, unknown>> {
    if (call.name === "run_command") {
      const job = await this.jobs.start(owner, run, call, signal, approved);
      const output = await this.jobs.read(owner, run, job.id, { waitSeconds: 0, tail: true }, tokens * 4, signal);
      return { ...output, action: call.name, targetId: job.targetId, command: job.command.slice(0, 2000), ok: job.status === "completed" && job.exitCode === 0 };
    }
    requireValue(typeof call.arguments.jobId === "string", 400, "JOB_REQUIRED", "需要有效 jobId");
    if (call.name === "read_job_output") return { action: call.name, ...await this.jobs.read(owner, run, call.arguments.jobId, call.arguments, tokens * 4, signal) };
    if (call.name === "cancel_job") {
      const job = await this.jobs.cancel(owner, run.id, call.arguments.jobId);
      return { action: call.name, jobId: job.id, status: job.status, exitCode: job.exitCode, error: job.error };
    }
    throw new RuntimeError(400, "UNKNOWN_TOOL", "不支持的工具");
  }
  private async loop(owner: string, run: RuntimeRun, execution: Execution, authorize: Authorization) {
    const signal = execution.controller.signal;
    const watchdog = new ProgressWatchdog();
    let checking = false;
    const monitor = setInterval(() => {
      if (checking || signal.aborted) return;
      checking = true;
      void authorize().catch(error => execution.controller.abort(error)).finally(() => { checking = false; });
    }, 10000);
    monitor.unref();
    try {
      run.status = "running";
      run.error = null;
      await this.store.saveRun(owner, run);
      // A task has no fixed round count. Abort, permission, progress and resource
      // checks are enforced on the server, never delegated to the renderer.
      while (!signal.aborted) {
        await authorize();
        signal.throwIfAborted();
        requireValue(process.memoryUsage().heapUsed < getHeapStatistics().heap_size_limit * 0.85, 503, "MEMORY_PRESSURE", "服务器内存压力过高，已暂停任务并保留记录");
        const source = await this.dependencies.config();
        requireValue(source.enabled, 403, "AGENT_DISABLED", "管理员已关闭 Agent");
        const modelName = run.options.model || source.model;
        let configuredWindow = source.contextWindowTokens || 32768;
        try {
          const overrides = JSON.parse(process.env.PANEL_AGENT_MODEL_CONTEXT_WINDOWS || "{}");
          const value = overrides[modelName];
          if (Number.isSafeInteger(value) && value >= 4096 && value <= 2000000) configuredWindow = value;
        } catch { /* Use the explicitly configured default. */ }
        const window = run.contextWindow ? Math.min(run.contextWindow, configuredWindow) : configuredWindow;
        const config = { ...source, maxTokens: Math.min(source.maxTokens, Math.floor(window / 4)) };
        const budget = new ContextBudget(window, config.maxTokens, modelName);
        const model = this.dependencies.model?.(config, run) ?? new OpenAIRuntimeModel(config, run);
        const task = this.store.message(owner, run.threadId, run.userSeq);
        const jobs = this.store.jobs(owner, run.id).slice(-12).map(job => ({ jobId: job.id, targetId: job.targetId, status: job.status, exitCode: job.exitCode, error: job.error }));
        try {
          const context = await prepareContext(this.store, owner, run, basePrompt(config, run, task, jobs), model, budget, signal, async () => { run.status = "compacting"; await this.store.saveRun(owner, run); });
          run.status = "running";
          run.contextTokens = context.tokens;
          run.contextWindow = window;
          await this.store.saveRun(owner, run);
          await watchdog.beforeModel(signal);
          const completion = await model.complete(context.messages, signal);
          signal.throwIfAborted();
          // Provider tool IDs may repeat in later responses. Runtime IDs are
          // unique, persisted, and replayed consistently in model messages.
          completion.message.toolCalls = completion.message.toolCalls?.map(call => ({ ...call, id: crypto.randomUUID() }));
          run.pending = completion.message.toolCalls ?? [];
          run.contextTokens = completion.promptTokens || context.tokens;
          await this.store.saveRun(owner, run, [completion.message]);
          if (!run.pending.length) {
            if (this.jobs.running(run.id).length) {
              await this.jobs.waitRun(run.id, signal);
              continue;
            }
            run.status = "completed";
            await this.store.saveRun(owner, run);
            return;
          }
          while (run.pending.length) {
            await authorize();
            signal.throwIfAborted();
            const call = run.pending[0];
            let approved = false;
            if (needsApproval(call)) approved = await this.waitApproval(owner, run, execution);
            signal.throwIfAborted();
            run.status = "running";
            await this.store.saveRun(owner, run);
            let result: Record<string, unknown>;
            if (needsApproval(call) && !approved) {
              result = { action: call.name, status: "blocked", blocked: true, error: "用户拒绝执行此命令。不要换一种写法绕过拒绝。" };
            } else {
              try { result = await this.perform(owner, run, call, signal, context.toolTokens, approved); }
              catch (error) {
                if (signal.aborted) throw error;
                if (error instanceof RuntimeError && error.status === 403) throw error;
                result = { action: call.name, status: "failed", error: redactEvidence(error instanceof Error ? error.message : String(error)).slice(0, 800) };
              }
            }
            signal.throwIfAborted();
            result = fitToolEvidence(result, budget, context.toolTokens);
            run.pending = run.pending.slice(1);
            await this.store.saveRun(owner, run, [{ id: crypto.randomUUID(), role: "tool", name: call.name, toolCallId: call.id, content: JSON.stringify(result) }]);
            if (watchdog.observe(call, result)) {
              run.status = "paused";
              run.error = "连续重复相同工具且没有新结果，已暂停防止空转。核对后可继续；这不是工具轮数上限。";
              await this.store.saveRun(owner, run);
              return;
            }
          }
        } catch (error) {
          if (error instanceof ContextOverflowError && window > 4096 && !run.pending.length) {
            run.contextWindow = Math.max(4096, Math.floor(window / 2));
            await this.store.saveRun(owner, run);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      run.status = signal.aborted && !(signal.reason instanceof RuntimeError) ? "cancelled" : "paused";
      run.error = redactEvidence(error instanceof Error ? error.message : String(error)).slice(0, 1000);
      try { await this.finishPending(owner, run, "Runtime paused or stopped; external command effects may require verification."); } catch { /* A persistence fault must not permit further tools. */ }
    } finally {
      clearInterval(monitor);
      execution.approval = null;
      await this.jobs.stopRun(owner, run.id).catch(() => {});
      if (!["completed", "paused", "cancelled", "interrupted"].includes(run.status)) run.status = "paused";
      await this.store.saveRun(owner, run).catch(() => {});
    }
  }
}
