import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { buildSharedTerminalCommand } from "./shared-terminal-command.js";
import path from "node:path";
import { promises as fs, constants } from "node:fs";
import { Client, type ClientChannel } from "ssh2";
import type {
  RuntimeJob,
  RuntimeRun,
  RuntimeTarget,
  RuntimeToolCall,
} from "../../types/panel-runtime.js";
import { resolveHostById } from "../hosts/host-resolver.js";
import {
  attachDedicatedKeyboardInteractive,
  buildDedicatedTransferConnectConfig,
  startDedicatedTransferConnect,
} from "../hosts/file-manager/ssh-connection.js";
import { RuntimeError, RuntimeStore, requireValue, validId } from "./store.js";
import { needsApproval, redactEvidence } from "./policy.js";
import { sessionManager } from "../hosts/terminal/session-manager.js";

export function positiveSetting(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export async function waitAtMost(
  done: Promise<void>,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason || new Error("Cancelled"));
    const timer = setTimeout(() => finish(), ms);
    signal.addEventListener("abort", abort, { once: true });
    done.then(() => finish(), finish);
    if (signal.aborted) abort();
  });
}
export class OutputSpool {
  private ready: Promise<void> | null = null;
  private used = 0;
  constructor(
    readonly root = path.resolve(
      process.env.PANEL_AGENT_OUTPUT_DIR ||
        path.join(process.env.DATA_DIR || "./db/data", "panel-agent-output"),
    ),
    private perJob = positiveSetting(
      "PANEL_AGENT_JOB_LOG_BYTES",
      512 * 1024 * 1024,
    ),
    private total = positiveSetting(
      "PANEL_AGENT_LOG_BYTES",
      4 * 1024 * 1024 * 1024,
    ),
  ) {}
  private async initialize() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(this.root);
    requireValue(
      directory.isDirectory() && !directory.isSymbolicLink(),
      409,
      "INVALID_OUTPUT_DIRECTORY",
      "日志目录必须是独立普通目录",
    );
    await fs.chmod(this.root, 0o700);
    for (const item of await fs.readdir(this.root, { withFileTypes: true })) {
      if (item.isFile() && /^[a-zA-Z0-9_-]+\.(stdout|stderr)$/.test(item.name))
        this.used += (await fs.stat(path.join(this.root, item.name))).size;
    }
  }
  private async init() {
    this.ready ??= this.initialize();
    await this.ready;
  }
  private filename(id: string, stream: "stdout" | "stderr") {
    requireValue(validId(id), 400, "INVALID_JOB_ID", "任务标识无效");
    return path.join(this.root, `${id}.${stream}`);
  }
  async remove(ids: string[]) {
    await this.init();
    for (const id of ids)
      for (const stream of ["stdout", "stderr"] as const) {
        const filename = this.filename(id, stream);
        try {
          const stat = await fs.lstat(filename);
          requireValue(
            stat.isFile(),
            409,
            "INVALID_OUTPUT_FILE",
            "Output is not a regular file",
          );
          await fs.unlink(filename);
          this.used = Math.max(0, this.used - stat.size);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
  }
  async create(id: string) {
    await this.init();
    for (const stream of ["stdout", "stderr"] as const) {
      const file = await fs.open(
        this.filename(id, stream),
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      await file.close();
    }
  }
  async append(job: RuntimeJob, stream: "stdout" | "stderr", data: Buffer) {
    await this.init();
    requireValue(
      job.stdoutBytes + job.stderrBytes + data.length <= this.perJob &&
        this.used + data.length <= this.total,
      507,
      "OUTPUT_STORAGE_LIMIT",
      "日志达到物理存储保护阈值，请清理记录或调整日志容量",
    );
    this.used += data.length;
    let file;
    try {
      file = await fs.open(
        this.filename(job.id, stream),
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      );
      await file.writeFile(data);
      job[stream === "stdout" ? "stdoutBytes" : "stderrBytes"] += data.length;
    } catch (error) {
      this.used -= data.length;
      throw error;
    } finally {
      await file?.close();
    }
  }
  async read(
    id: string,
    stream: "stdout" | "stderr",
    offset: number,
    maxBytes: number,
    tail = false,
  ) {
    await this.init();
    let file;
    try {
      file = await fs.open(
        this.filename(id, stream),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { text: "", offset: 0, nextOffset: 0, total: 0 };
      throw error;
    }
    try {
      const stat = await file.stat();
      requireValue(
        stat.isFile(),
        409,
        "INVALID_OUTPUT_FILE",
        "输出不是普通文件",
      );
      const count = Math.max(
        0,
        Math.min(8 * 1024 * 1024, Math.floor(maxBytes)),
      );
      const start = tail
        ? Math.max(0, stat.size - count)
        : Math.min(stat.size, offset);
      const buffer = Buffer.alloc(Math.min(count, stat.size - start));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      return {
        text: buffer.subarray(0, bytesRead).toString("utf8"),
        offset: start,
        nextOffset: start + bytesRead,
        total: stat.size,
      };
    } finally {
      await file.close();
    }
  }
}

export async function connectRuntimeHost(
  owner: string,
  target: RuntimeTarget,
  signal: AbortSignal,
): Promise<Client> {
  signal.throwIfAborted();
  const host = await resolveHostById(
    target.hostId,
    owner,
    target.projectHostId,
  );
  requireValue(
    host && host.enableSsh !== false,
    403,
    "HOST_ACCESS_DENIED",
    "服务器权限已撤销或未启用 SSH",
  );
  const fingerprint = (host as unknown as Record<string, unknown>)
    .hostKeyFingerprint;
  requireValue(
    typeof fingerprint === "string" && fingerprint.length > 0,
    409,
    "HOST_KEY_NOT_PINNED",
    "请先通过网页终端核对并保存目标服务器 Host Key",
  );
  const client = new Client();
  client.on("error", () => {});
  attachDedicatedKeyboardInteractive(client, host);
  try {
    const config = await buildDedicatedTransferConnectConfig(
      host,
      owner,
      client,
    );
    config.keepaliveInterval = 15000;
    config.keepaliveCountMax = 4;
    config.readyTimeout = 30000;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        client.removeListener("ready", ready);
        client.removeListener("error", failed);
        client.removeListener("close", closed);
        if (error) reject(error);
        else resolve();
      };
      const ready = () => finish();
      const failed = (error: Error) => finish(error);
      const closed = () =>
        finish(new Error("SSH closed before authentication completed"));
      const abort = () => {
        client.destroy();
        finish(signal.reason || new Error("SSH canceled"));
      };
      const timer = setTimeout(() => {
        client.destroy();
        finish(new Error("SSH connection deadline exceeded"));
      }, 60000);
      client.once("ready", ready);
      client.once("error", failed);
      client.once("close", closed);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      void startDedicatedTransferConnect(
        client,
        config,
        host,
        owner,
        signal,
      ).catch(finish);
    });
    return client;
  } catch (error) {
    client.destroy();
    throw error;
  }
}

const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
type LiveJob = {
  job: RuntimeJob;
  controller: AbortController;
  done: Promise<void>;
};
export class RuntimeJobs {
  private live = new Map<string, LiveJob>();
  private sharedRecoveryRequired = new Set<string>();
  private failures = new Map<string, RuntimeError>();
  checkHealthy(runId: string) {
    const error = this.failures.get(runId);
    if (error) throw error;
  }
  clearFailure(runId: string) {
    this.failures.delete(runId);
  }
  constructor(
    private store: RuntimeStore,
    private authorize: (owner: string, target: RuntimeTarget) => Promise<void>,
    readonly spool = new OutputSpool(),
    private connect = connectRuntimeHost,
  ) {}
  running(runId: string) {
    return [...this.live.values()].filter((item) => item.job.runId === runId);
  }

  private terminalTrace(
    owner: string,
    target: RuntimeTarget,
    payload: Record<string, unknown>,
  ) {
    if (!target.terminalSessionId) return;
    const session = sessionManager.getSession(target.terminalSessionId);
    if (
      !session ||
      session.userId !== owner ||
      session.hostId !== target.hostId ||
      !session.isConnected
    )
      return;
    sessionManager.broadcast(session.id, { type: "agentTrace", ...payload });
  }

  async start(
    owner: string,
    run: RuntimeRun,
    call: RuntimeToolCall,
    signal: AbortSignal,
    approved = false,
  ): Promise<RuntimeJob> {
    this.checkHealthy(run.id);
    const persisted = this.store.run(owner, run.id);
    requireValue(
      persisted.status === "running" &&
        JSON.stringify(persisted.pending[0]) === JSON.stringify(call),
      409,
      "TOOL_NOT_PENDING",
      "工具必须来自已保存的当前任务",
    );
    requireValue(
      !needsApproval(call) || approved,
      403,
      "APPROVAL_REQUIRED",
      "该命令需要当前用户明确确认",
    );
    const target = persisted.targets.find(
      (item) => item.targetId === call.arguments.targetId,
    );
    requireValue(
      target,
      403,
      "TARGET_NOT_SELECTED",
      "工具目标不在本轮授权范围内",
    );
    await this.authorize(owner, target);
    signal.throwIfAborted();
    const previous = this.store
      .jobs(owner, run.id)
      .find((job) => job.toolCallId === call.id);
    if (previous) return this.live.get(previous.id)?.job ?? previous;
    requireValue(
      !this.running(run.id).some((item) => item.job.hostId === target.hostId),
      409,
      "JOB_STILL_RUNNING",
      "请先读取或等待已有 jobId，不要重叠提交命令",
    );
    requireValue(
      this.live.size < positiveSetting("PANEL_AGENT_CONCURRENT_JOBS", 8),
      429,
      "JOB_CAPACITY",
      "执行资源忙，请稍后重试",
    );
    const command = call.arguments.command;
    requireValue(
      typeof command === "string" &&
        command.trim() &&
        command.length <= 256000 &&
        !command.includes("\0"),
      400,
      "INVALID_COMMAND",
      "命令无效；不会截断命令后执行",
    );
    const cwd = call.arguments.cwd;
    requireValue(
      cwd === undefined ||
        (typeof cwd === "string" && cwd.length <= 8192 && !cwd.includes("\0")),
      400,
      "INVALID_CWD",
      "工作目录无效",
    );
    const defaultTimeout = Math.max(
      1,
      Math.min(
        86400,
        Math.floor(
          positiveSetting("PANEL_AGENT_COMMAND_TIMEOUT_MS", 600000) / 1000,
        ),
      ),
    );
    const timeout = Number(call.arguments.timeoutSeconds ?? defaultTimeout);
    requireValue(
      Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 86400,
      400,
      "INVALID_DEADLINE",
      "命令期限应为 1 到 86400 秒",
    );
    const job: RuntimeJob = {
      id: crypto.randomUUID(),
      runId: run.id,
      toolCallId: call.id,
      targetId: target.targetId,
      hostId: target.hostId,
      command,
      cwd: cwd as string | undefined,
      status: "starting",
      exitCode: null,
      signal: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    await this.spool.create(job.id);
    try {
      await this.store.saveJob(owner, job);
    } catch {
      const failure = new RuntimeError(
        503,
        "JOB_PERSISTENCE_FAILED",
        "工具执行意图保存失败，未建立 SSH 任务",
      );
      this.failures.set(run.id, failure);
      throw failure;
    }
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.live.set(job.id, { job, controller, done });
    const sshMode = persisted.options.sshMode ?? "isolated";
    void (
      sshMode === "shared-terminal"
        ? this.executeSharedTerminal(owner, target, job, timeout, controller)
        : this.execute(
            owner,
            target,
            job,
            timeout,
            controller,
            sshMode === "mirror",
          )
    )
      .catch((error) => {
        job.status = "failed";
        job.error = redactEvidence(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 800);
      })
      .finally(async () => {
        signal.removeEventListener("abort", abort);
        job.finishedAt = Date.now();
        try {
          await this.store.saveJob(owner, job);
        } catch {
          job.status = "interrupted";
          job.error = "状态保存失败，结果需人工核对";
          this.failures.set(
            job.runId,
            new RuntimeError(503, "JOB_PERSISTENCE_FAILED", job.error),
          );
        }
        this.live.delete(job.id);
        resolveDone();
      });
    if (signal.aborted) abort();
    await waitAtMost(done, 1200, signal);
    this.checkHealthy(run.id);
    return { ...job };
  }
  private async executeSharedTerminal(
    owner: string,
    target: RuntimeTarget,
    job: RuntimeJob,
    timeout: number,
    controller: AbortController,
  ) {
    const signal = controller.signal;
    const sessionId = target.terminalSessionId;
    requireValue(
      sessionId,
      409,
      "SHARED_TERMINAL_REQUIRED",
      "共享当前 SSH 需要一个已连接终端",
    );
    requireValue(
      !this.sharedRecoveryRequired.has(sessionId),
      409,
      "SHARED_TERMINAL_RECOVERY_REQUIRED",
      "上次共享命令中断后未收到 Shell 结束标记。请人工核对，关闭该终端并建立新 SSH，或改用独立执行；不会自动重放命令。",
    );
    const leaseId = `panel-agent-${job.id}`;
    const token = crypto.randomBytes(16).toString("hex");
    const beginMarker = `\u001b]777;cloudssh-agent-begin=${token}\u0007`;
    const endPrefix = `\u001b]777;cloudssh-agent-end=${token};status=`;
    let queue = Promise.resolve();
    let pendingBytes = 0;
    let outputFailed = false;
    let timedOut = false;
    let commandDispatched = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Command deadline exceeded"));
    }, timeout * 1000);

    try {
      await this.authorize(owner, target);
      signal.throwIfAborted();
      const session = sessionManager.acquireAgentRuntimeLease(
        sessionId,
        owner,
        target.hostId,
        leaseId,
        token,
      );
      const stream = session.sshStream!;
      job.status = "running";
      this.terminalTrace(owner, target, {
        phase: "start",
        jobId: job.id,
        command: job.command,
        shared: true,
      });
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let state: "waiting" | "capturing" | "status" = "waiting";
        let carry = "";
        const decoder = new StringDecoder("utf8");
        let abortTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          if (state === "capturing") {
            let tail = carry + decoder.end();
            carry = "";
            for (
              let size = Math.min(tail.length, endPrefix.length);
              size > 0;
              size -= 1
            ) {
              if (endPrefix.startsWith(tail.slice(-size))) {
                tail = tail.slice(0, -size);
                break;
              }
            }
            append(tail);
          }
          if (abortTimer) clearTimeout(abortTimer);
          signal.removeEventListener("abort", abort);
          stream.removeListener("data", onData);
          stream.removeListener("error", failed);
          stream.removeListener("close", closed);
          if (error) reject(error);
          else resolve();
        };
        const failed = (error: Error) => finish(error);
        const closed = () =>
          finish(new Error("共享 SSH 会话在命令完成前已断开"));
        const append = (value: string) => {
          if (!value) return;
          const data = Buffer.from(value, "utf8");
          pendingBytes += data.length;
          if (pendingBytes > 8 * 1024 * 1024) {
            outputFailed = true;
            controller.abort(
              new Error("Output write backlog exceeded memory safety window"),
            );
            return;
          }
          queue = queue
            .then(() => this.spool.append(job, "stdout", data))
            .catch((error) => {
              outputFailed = true;
              job.error =
                error instanceof Error ? error.message : String(error);
              controller.abort(error);
            })
            .finally(() => {
              pendingBytes -= data.length;
            });
        };
        const consumeStatus = (value: string) => {
          const bell = value.indexOf("\u0007");
          if (bell < 0) {
            carry = value.slice(0, 64);
            return;
          }
          const raw = value.slice(0, bell);
          const code = Number.parseInt(raw, 10);
          job.exitCode = Number.isSafeInteger(code) ? code : null;
          finish();
        };
        const consumeCapture = (value: string) => {
          const end = value.indexOf(endPrefix);
          if (end >= 0) {
            append(value.slice(0, end));
            state = "status";
            consumeStatus(value.slice(end + endPrefix.length));
            return;
          }
          const keep = Math.min(
            value.length,
            Math.max(0, endPrefix.length - 1),
          );
          append(value.slice(0, value.length - keep));
          carry = keep ? value.slice(-keep) : "";
        };
        const onData = (chunk: Buffer | string) => {
          let value =
            carry + (Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk);
          carry = "";
          if (state === "waiting") {
            const begin = value.indexOf(beginMarker);
            if (begin < 0) {
              const keep = Math.min(
                value.length,
                Math.max(0, beginMarker.length - 1),
              );
              carry = keep ? value.slice(-keep) : "";
              return;
            }
            state = "capturing";
            value = value.slice(begin + beginMarker.length);
          }
          if (state === "capturing") consumeCapture(value);
          else if (state === "status") consumeStatus(value);
        };
        const abort = () => {
          if (settled || abortTimer) return;
          if (!commandDispatched) {
            finish(signal.reason);
            return;
          }
          try {
            stream.write("\u0003");
          } catch {
            // The shared shell may already be gone.
          }
          abortTimer = setTimeout(() => finish(), 1500);
        };

        stream.prependListener("data", onData);
        stream.once("error", failed);
        stream.once("close", closed);
        signal.addEventListener("abort", abort, { once: true });

        const wrapper = buildSharedTerminalCommand(job.command, job.cwd, token);
        try {
          signal.throwIfAborted();
          commandDispatched = true;
          stream.write(wrapper);
        } catch (error) {
          finish(error);
        }
        if (signal.aborted) abort();
      });

      await queue;
      if (signal.aborted) {
        job.status = outputFailed
          ? "output_limit"
          : timedOut
            ? "timed_out"
            : "cancelled";
        job.error ||= "已请求中断共享终端命令；远端前台进程可能需要人工核对";
      } else if (job.exitCode === null) {
        job.status = "interrupted";
        job.error = "共享终端没有返回命令结束标记，结果未知";
      } else {
        job.status = job.exitCode === 0 ? "completed" : "failed";
      }
    } catch (error) {
      await queue;
      job.status = outputFailed
        ? "output_limit"
        : timedOut
          ? "timed_out"
          : signal.aborted
            ? "cancelled"
            : "interrupted";
      job.error = redactEvidence(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 800);
    } finally {
      clearTimeout(timer);
      if (commandDispatched && job.exitCode === null) {
        const session = sessionManager.getSession(sessionId);
        if (session?.isConnected && session.sshStream) {
          this.sharedRecoveryRequired.add(sessionId);
          session.sshStream.once("close", () =>
            this.sharedRecoveryRequired.delete(sessionId),
          );
        }
      }
      sessionManager.releaseAgentRuntimeLease(sessionId, leaseId);
      this.terminalTrace(owner, target, {
        phase: "end",
        jobId: job.id,
        status: job.status,
        exitCode: job.exitCode,
        shared: true,
      });
    }
  }

  private async execute(
    owner: string,
    target: RuntimeTarget,
    job: RuntimeJob,
    timeout: number,
    controller: AbortController,
    mirror = false,
  ) {
    const signal = controller.signal;
    const traceDecoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    let client: Client | undefined;
    let stream: ClientChannel | undefined;
    let timedOut = false;
    let outputFailed = false;
    let queue = Promise.resolve();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Command deadline exceeded"));
    }, timeout * 1000);
    if (mirror) {
      this.terminalTrace(owner, target, {
        phase: "start",
        jobId: job.id,
        command: job.command,
        shared: false,
      });
    }
    try {
      await this.authorize(owner, target);
      client = await this.connect(owner, target, signal);
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          if (closeTimer) clearTimeout(closeTimer);
          signal.removeEventListener("abort", abort);
          client!.removeListener("error", failed);
          client!.removeListener("close", closed);
          if (error) reject(error);
          else resolve();
        };
        const failed = (error: Error) => finish(error);
        const closed = () =>
          finish(new Error("SSH disconnected; remote execution state unknown"));
        const abort = () => {
          if (settled || closeTimer) return;
          try {
            stream?.signal("TERM");
          } catch {
            /* Remote server may not support signals. */
          }
          closeTimer = setTimeout(() => {
            client?.destroy();
            finish();
          }, 1500);
        };
        client!.once("error", failed);
        client!.once("close", closed);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        const command = job.cwd
          ? `cd -- ${shellQuote(job.cwd)} && ${job.command}`
          : job.command;
        client!.exec(command, { pty: false }, (error, channel) => {
          if (error) {
            finish(error);
            return;
          }
          if (settled) {
            channel.close();
            return;
          }
          stream = channel;
          job.status = "running";
          let pendingBytes = 0;
          const receive = (kind: "stdout" | "stderr", data: Buffer) => {
            if (signal.aborted) return;
            if (mirror) {
              this.terminalTrace(owner, target, {
                phase: kind,
                data: traceDecoders[kind].write(data),
                jobId: job.id,
                shared: false,
              });
            }
            pendingBytes += data.length;
            if (pendingBytes > 8 * 1024 * 1024) {
              outputFailed = true;
              controller.abort(
                new Error("Output write backlog exceeded memory safety window"),
              );
              return;
            }
            channel.pause();
            channel.stderr.pause();
            queue = queue
              .then(() => this.spool.append(job, kind, Buffer.from(data)))
              .catch((error) => {
                outputFailed = true;
                job.error =
                  error instanceof Error ? error.message : String(error);
                controller.abort(error);
              })
              .finally(() => {
                pendingBytes -= data.length;
                if (!signal.aborted) {
                  channel.resume();
                  channel.stderr.resume();
                }
              });
          };
          channel.on("data", (data: Buffer) => receive("stdout", data));
          channel.stderr.on("data", (data: Buffer) => receive("stderr", data));
          channel.on("error", failed);
          channel.stderr.on("error", failed);
          channel.on(
            "exit",
            (code: number | null, exitSignal: string | null) => {
              job.exitCode = typeof code === "number" ? code : null;
              job.signal = exitSignal || null;
            },
          );
          channel.once("close", () => finish());
          channel.end();
          if (signal.aborted) abort();
        });
      });
      await queue;
      if (signal.aborted) {
        job.status = outputFailed
          ? "output_limit"
          : timedOut
            ? "timed_out"
            : "cancelled";
        job.error ||=
          "已请求终止独立任务；远端可能忽略信号，不能确认所有子进程已结束";
      } else if (job.exitCode === null) {
        job.status = "interrupted";
        job.error = "SSH 未返回退出状态，结果未知";
      } else job.status = job.exitCode === 0 ? "completed" : "failed";
    } catch (error) {
      await queue;
      job.status = outputFailed
        ? "output_limit"
        : timedOut
          ? "timed_out"
          : signal.aborted
            ? "cancelled"
            : "interrupted";
      job.error = redactEvidence(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 800);
    } finally {
      clearTimeout(timer);
      try {
        stream?.close();
        client?.end();
      } catch {
        /* Only the dedicated channel is closed. */
      }
      if (mirror) {
        for (const kind of ["stdout", "stderr"] as const) {
          const tail = traceDecoders[kind].end();
          if (tail)
            this.terminalTrace(owner, target, {
              phase: kind,
              data: tail,
              jobId: job.id,
              shared: false,
            });
        }
        this.terminalTrace(owner, target, {
          phase: "end",
          jobId: job.id,
          status: job.status,
          exitCode: job.exitCode,
          shared: false,
        });
      }
    }
  }
  async read(
    owner: string,
    run: RuntimeRun,
    id: string,
    args: Record<string, unknown>,
    maxBytes: number,
    signal: AbortSignal,
  ) {
    this.checkHealthy(run.id);
    let job = this.store.job(owner, id);
    requireValue(
      job.runId === run.id,
      403,
      "JOB_SCOPE",
      "只能读取本轮任务输出",
    );
    const target = run.targets.find((item) => item.hostId === job.hostId);
    requireValue(target, 403, "JOB_SCOPE", "任务服务器不在授权范围内");
    await this.authorize(owner, target);
    const wait = Math.max(0, Math.min(20, Number(args.waitSeconds ?? 3) || 0));
    const active = this.live.get(id);
    if (active) {
      await waitAtMost(active.done, wait * 1000, signal);
      this.checkHealthy(run.id);
      job = { ...active.job };
    }
    const offset = (value: unknown) => {
      const n = Number(value ?? 0);
      requireValue(
        Number.isSafeInteger(n) && n >= 0,
        400,
        "INVALID_OFFSET",
        "输出游标无效",
      );
      return n;
    };
    if (args.maxBytes !== undefined) {
      const requested = Number(args.maxBytes);
      requireValue(
        Number.isSafeInteger(requested) && requested >= 128,
        400,
        "INVALID_OUTPUT_SIZE",
        "Output page size invalid",
      );
      maxBytes = Math.min(maxBytes, requested);
    }
    const stdout = await this.spool.read(
      id,
      "stdout",
      offset(args.stdoutOffset),
      maxBytes / 2,
      args.tail === true,
    );
    const stderr = await this.spool.read(
      id,
      "stderr",
      offset(args.stderrOffset),
      maxBytes / 2,
      args.tail === true,
    );
    return {
      jobId: id,
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      stdout: redactEvidence(stdout.text),
      stderr: redactEvidence(stderr.text),
      stdoutOffset: stdout.offset,
      stderrOffset: stderr.offset,
      nextStdoutOffset: stdout.nextOffset,
      nextStderrOffset: stderr.nextOffset,
      stdoutBytes: stdout.total,
      stderrBytes: stderr.total,
      hasMore:
        stdout.nextOffset < stdout.total || stderr.nextOffset < stderr.total,
      error: job.error,
    };
  }
  async cancel(owner: string, runId: string, id: string) {
    const job = this.store.job(owner, id);
    requireValue(job.runId === runId, 403, "JOB_SCOPE", "只能停止本轮任务");
    const active = this.live.get(id);
    if (active) {
      active.controller.abort(new Error("请求停止"));
      await active.done;
      return { ...active.job };
    }
    return job;
  }
  async stopRun(owner: string, runId: string) {
    await Promise.all(
      this.running(runId).map((item) => this.cancel(owner, runId, item.job.id)),
    );
  }
  async waitRun(runId: string, signal: AbortSignal) {
    await Promise.all(
      this.running(runId).map((item) => waitAtMost(item.done, 20000, signal)),
    );
  }
}
