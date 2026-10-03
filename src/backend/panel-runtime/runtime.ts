import crypto from "node:crypto";
import { getHeapStatistics } from "node:v8";
import type {
  RuntimeMessage,
  RuntimeRun,
  RuntimeToolCall,
  StartRuntimeInput,
} from "../../types/panel-runtime.js";
import { RuntimeStore, RuntimeError, requireValue } from "./store.js";
import { RuntimeJobs, positiveSetting } from "./jobs.js";
import { ContextBudget, fitToolEvidence, prepareContext } from "./context.js";
import {
  basePrompt,
  ContextOverflowError,
  OpenAIRuntimeModel,
  type RuntimeModel,
  type RuntimeModelConfig,
} from "./model.js";
import { needsApproval, ProgressWatchdog, redactEvidence } from "./policy.js";

type Authorization = () => Promise<void>;
type Execution = {
  owner: string;
  controller: AbortController;
  done: Promise<void>;
  approval: ((approved: boolean) => void) | null;
};
export type RuntimeDependencies = {
  config: () => Promise<RuntimeModelConfig>;
  model?: (config: RuntimeModelConfig, run: RuntimeRun) => RuntimeModel;
  watchdog?: () => ProgressWatchdog;
};
export class PanelRuntime {
  private executions = new Map<string, Execution>();
  private initialized: Promise<void> | null = null;
  private lifecycle = Promise.resolve();
  constructor(
    readonly store: RuntimeStore,
    readonly jobs: RuntimeJobs,
    private dependencies: RuntimeDependencies,
  ) {}
  async initialize() {
    this.initialized ??= this.store.recoverInterrupted().catch((error) => {
      this.initialized = null;
      throw error;
    });
    await this.initialized;
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.lifecycle.then(operation);
    this.lifecycle = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  async start(
    owner: string,
    input: StartRuntimeInput,
    authorize: Authorization,
  ) {
    await this.initialize();
    return this.exclusive(async () => {
      await authorize();
      // An acknowledgement retry must work even when the runtime is at capacity.
      const existing = this.store.hasRun(owner, input.requestId);
      requireValue(
        existing ||
          this.executions.size <
            positiveSetting("PANEL_AGENT_CONCURRENT_RUNS", 8),
        429,
        "RUNTIME_BUSY",
        "Agent 执行资源忙，请稍后重试",
      );
      const { run } = await this.store.start(owner, input);
      if (run.status === "queued" && !this.executions.has(run.id))
        this.launch(owner, run, authorize);
      return run;
    });
  }
  private launch(owner: string, run: RuntimeRun, authorize: Authorization) {
    const execution: Execution = {
      owner,
      controller: new AbortController(),
      done: Promise.resolve(),
      approval: null,
    };
    this.executions.set(run.id, execution);
    execution.done = this.loop(owner, run, execution, authorize).finally(() =>
      this.executions.delete(run.id),
    );
    void execution.done.catch(() => {});
  }
  private async finishPending(owner: string, run: RuntimeRun, reason: string) {
    const messages: RuntimeMessage[] = run.pending.map((call) => ({
      id: crypto.randomUUID(),
      role: "tool",
      name: call.name,
      toolCallId: call.id,
      content: JSON.stringify({
        status: "interrupted",
        error: reason,
        instruction:
          "Inspect job state before retrying. This does not prove that a remote command did or did not run.",
      }),
    }));
    run.pending = [];
    await this.store.saveRun(owner, run, messages);
  }
  async resume(owner: string, id: string, authorize: Authorization) {
    await this.initialize();
    return this.exclusive(async () => {
      const run = this.store.run(owner, id);
      requireValue(
        !this.executions.has(id) &&
          ["paused", "interrupted", "failed"].includes(run.status),
        409,
        "RUN_NOT_PAUSED",
        "该任务不能重复启动",
      );
      requireValue(
        this.executions.size <
          positiveSetting("PANEL_AGENT_CONCURRENT_RUNS", 8),
        429,
        "RUNTIME_BUSY",
        "Agent 执行资源忙",
      );
      await authorize();
      await this.finishPending(
        owner,
        run,
        "Previous execution was interrupted; inspect unknown mutations before continuing.",
      );
      run.status = "queued";
      run.error = null;
      run.contextWindow = 0;
      await this.store.saveRun(owner, run);
      this.jobs.clearFailure(run.id);
      this.launch(owner, run, authorize);
      return run;
    });
  }
  async approve(
    owner: string,
    id: string,
    toolCallId: string,
    approved: boolean,
    authorize: Authorization,
  ) {
    return this.exclusive(async () => {
      const run = this.store.run(owner, id);
      const execution = this.executions.get(id);
      requireValue(
        run.status === "waiting_approval" &&
          run.pending[0]?.id === toolCallId &&
          execution?.owner === owner &&
          execution.approval,
        409,
        "APPROVAL_CHANGED",
        "待确认命令已变化，请刷新后核对",
      );
      const resolve = execution.approval;
      await authorize();
      requireValue(
        execution.approval === resolve && !execution.controller.signal.aborted,
        409,
        "APPROVAL_CHANGED",
        "任务已停止或确认已处理",
      );
      execution.approval = null;
      resolve(approved);
    });
  }
  async cancel(owner: string, id: string) {
    const execution = await this.exclusive(async () => {
      const run = this.store.run(owner, id);
      const active = this.executions.get(id);
      if (active) {
        requireValue(
          active.owner === owner,
          403,
          "RUN_OWNER",
          "无权停止该任务",
        );
        active.controller.abort(new Error("用户停止任务"));
      } else if (!["completed", "cancelled"].includes(run.status)) {
        run.status = "cancelled";
        await this.finishPending(
          owner,
          run,
          "Cancelled; verify remote state before repeating work.",
        );
      }
      return active;
    });
    await execution?.done;
    return this.store.run(owner, id);
  }
  private async waitApproval(
    owner: string,
    run: RuntimeRun,
    execution: Execution,
  ) {
    const signal = execution.controller.signal;
    let cleanup = () => {};
    const answer = new Promise<boolean>((resolve, reject) => {
      const abort = () => {
        execution.approval = null;
        reject(signal.reason);
      };
      cleanup = () => signal.removeEventListener("abort", abort);
      execution.approval = (value) => {
        cleanup();
        execution.approval = null;
        resolve(value);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    // Observe cancellation even if disk persistence fails before awaiting answer.
    void answer.catch(() => {});
    try {
      run.status = "waiting_approval";
      await this.store.saveRun(owner, run);
      return await answer;
    } finally {
      cleanup();
      execution.approval = null;
    }
  }
  private async perform(
    owner: string,
    run: RuntimeRun,
    call: RuntimeToolCall,
    signal: AbortSignal,
    bytes: number,
    approved: boolean,
  ): Promise<Record<string, unknown>> {
    this.jobs.checkHealthy(run.id);
    if (call.name === "run_command") {
      const job = await this.jobs.start(owner, run, call, signal, approved);
      const output = await this.jobs.read(
        owner,
        run,
        job.id,
        { waitSeconds: 0, tail: true },
        bytes,
        signal,
      );
      return {
        ...output,
        action: call.name,
        targetId: job.targetId,
        command: job.command.slice(0, 2000),
        ok: job.status === "completed" && job.exitCode === 0,
      };
    }
    requireValue(
      typeof call.arguments.jobId === "string",
      400,
      "JOB_REQUIRED",
      "需要有效 jobId",
    );
    if (call.name === "read_job_output")
      return {
        action: call.name,
        ...(await this.jobs.read(
          owner,
          run,
          call.arguments.jobId,
          call.arguments,
          bytes,
          signal,
        )),
      };
    if (call.name === "cancel_job") {
      const job = await this.jobs.cancel(owner, run.id, call.arguments.jobId);
      return {
        action: call.name,
        jobId: job.id,
        status: job.status,
        exitCode: job.exitCode,
        error: job.error,
      };
    }
    throw new RuntimeError(400, "UNKNOWN_TOOL", "不支持的工具");
  }
  private async loop(
    owner: string,
    run: RuntimeRun,
    execution: Execution,
    authorize: Authorization,
  ) {
    const signal = execution.controller.signal;
    const watchdog = this.dependencies.watchdog?.() ?? new ProgressWatchdog();
    let checking = false;
    const monitor = setInterval(() => {
      if (checking || signal.aborted) return;
      checking = true;
      void authorize()
        .catch((error) => execution.controller.abort(error))
        .finally(() => {
          checking = false;
        });
    }, 10000);
    monitor.unref();
    try {
      run.status = "running";
      run.error = null;
      await this.store.saveRun(owner, run);
      while (!signal.aborted) {
        await authorize();
        signal.throwIfAborted();
        this.jobs.checkHealthy(run.id);
        requireValue(
          process.memoryUsage().heapUsed <
            getHeapStatistics().heap_size_limit * 0.85,
          503,
          "MEMORY_PRESSURE",
          "服务器内存压力过高，已暂停任务并保留记录",
        );
        const source = await this.dependencies.config();
        requireValue(
          source.enabled,
          403,
          "AGENT_DISABLED",
          "管理员已关闭 Agent",
        );
        const modelName = run.options.model || source.model;
        let configuredWindow = source.contextWindowTokens || 32768;
        try {
          const overrides = JSON.parse(
            process.env.PANEL_AGENT_MODEL_CONTEXT_WINDOWS || "{}",
          );
          const value = overrides[modelName];
          if (Number.isSafeInteger(value) && value >= 4096 && value <= 2000000)
            configuredWindow = value;
        } catch {
          /* Keep configured default, never guess a larger provider window. */
        }
        const window = run.contextWindow
          ? Math.min(run.contextWindow, configuredWindow)
          : configuredWindow;
        const config = {
          ...source,
          maxTokens: Math.min(source.maxTokens, Math.floor(window / 4)),
        };
        const budget = new ContextBudget(window, config.maxTokens, modelName);
        const model =
          this.dependencies.model?.(config, run) ??
          new OpenAIRuntimeModel(config, run);
        const task = this.store.message(owner, run.threadId, run.userSeq);
        const jobs = this.store
          .jobs(owner, run.id)
          .slice(-12)
          .map((job) => ({
            jobId: job.id,
            targetId: job.targetId,
            status: job.status,
            exitCode: job.exitCode,
            error: job.error,
          }));
        try {
          const context = await prepareContext(
            this.store,
            owner,
            run,
            basePrompt(config, run, task, jobs),
            model,
            budget,
            signal,
            async () => {
              run.status = "compacting";
              await this.store.saveRun(owner, run);
            },
          );
          run.status = "running";
          run.contextTokens = context.tokens;
          run.contextWindow = window;
          await this.store.saveRun(owner, run);
          await watchdog.beforeModel(signal);
          const completion = await model.complete(context.messages, signal);
          signal.throwIfAborted();
          completion.message.toolCalls = completion.message.toolCalls?.map(
            (call) => ({ ...call, id: crypto.randomUUID() }),
          );
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
          const evidenceTokens = Math.max(
            128,
            Math.floor(context.toolTokens / run.pending.length),
          );
          while (run.pending.length) {
            await authorize();
            signal.throwIfAborted();
            const call = run.pending[0];
            const requiresApproval = needsApproval(call);
            const autoApproved =
              requiresApproval && run.options.approvalMode === "auto";
            const approved = requiresApproval
              ? autoApproved
                ? true
                : await this.waitApproval(owner, run, execution)
              : false;
            signal.throwIfAborted();
            // Permission can change while the user is reading the approval card.
            await authorize();
            run.status = "running";
            await this.store.saveRun(owner, run);
            let result: Record<string, unknown>;
            if (requiresApproval && !approved)
              result = {
                action: call.name,
                status: "blocked",
                blocked: true,
                error: "用户拒绝执行此命令。不得改写命令绕过拒绝。",
              };
            else {
              try {
                result = await this.perform(
                  owner,
                  run,
                  call,
                  signal,
                  budget.bytesForTokens(evidenceTokens),
                  approved,
                );
              } catch (error) {
                if (
                  signal.aborted ||
                  (error instanceof RuntimeError &&
                    (error.status === 403 ||
                      error.code === "JOB_PERSISTENCE_FAILED"))
                )
                  throw error;
                result = {
                  action: call.name,
                  status: "failed",
                  error: redactEvidence(
                    error instanceof Error ? error.message : String(error),
                  ).slice(0, 800),
                };
              }
            }
            signal.throwIfAborted();
            result = fitToolEvidence(result, budget, evidenceTokens);
            run.pending = run.pending.slice(1);
            await this.store.saveRun(owner, run, [
              {
                id: crypto.randomUUID(),
                role: "tool",
                name: call.name,
                toolCallId: call.id,
                content: JSON.stringify(result),
              },
            ]);
            if (watchdog.observe(call, result)) {
              run.status = "paused";
              run.error =
                "检测到重复工具循环且结果没有变化，已暂停空转。核对后可继续；不是工具次数上限。";
              await this.finishPending(
                owner,
                run,
                "Remaining tool calls were not executed because the progress watchdog paused this run.",
              );
              return;
            }
          }
        } catch (error) {
          if (
            error instanceof ContextOverflowError &&
            window > 4096 &&
            !run.pending.length
          ) {
            run.contextWindow = Math.max(4096, Math.floor(window / 2));
            await this.store.saveRun(owner, run);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      run.status =
        signal.aborted && !(signal.reason instanceof RuntimeError)
          ? "cancelled"
          : "paused";
      run.error = redactEvidence(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 1000);
      try {
        await this.finishPending(
          owner,
          run,
          "Paused or stopped; external command effects may need verification.",
        );
      } catch {
        /* Never execute further tools after persistence faults. */
      }
    } finally {
      clearInterval(monitor);
      execution.approval = null;
      await this.jobs.stopRun(owner, run.id).catch(() => {});
      if (
        !["completed", "paused", "cancelled", "interrupted"].includes(
          run.status,
        )
      )
        run.status = "paused";
      await this.store.saveRun(owner, run).catch(() => {});
    }
  }
}
