import crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
  RuntimeJob,
  RuntimeMessage,
  RuntimeRun,
  RuntimeSnapshot,
  RuntimeThread,
  StartRuntimeInput,
} from "../../types/panel-runtime.js";

export class RuntimeError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireValue(
  condition: unknown,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new RuntimeError(status, code, message);
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}
const parse = <T>(row: unknown): T | null =>
  row ? (JSON.parse((row as { payload: string }).payload) as T) : null;

/** Uses the existing encrypted database lifecycle, not a second database/key. */
export class RuntimeStore {
  constructor(
    private db: Database,
    private persist: () => Promise<void> = async () => {},
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS panel_runtime_threads (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', summary_seq INTEGER NOT NULL DEFAULT 0,
        last_seq INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS panel_runtime_threads_owner ON panel_runtime_threads(user_id, updated_at);
      CREATE TABLE IF NOT EXISTS panel_runtime_messages (
        thread_id TEXT NOT NULL REFERENCES panel_runtime_threads(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(thread_id,seq), UNIQUE(thread_id,id)
      );
      CREATE TABLE IF NOT EXISTS panel_runtime_runs (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES panel_runtime_threads(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS panel_runtime_runs_owner ON panel_runtime_runs(user_id, updated_at);
      CREATE TABLE IF NOT EXISTS panel_runtime_jobs (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES panel_runtime_runs(id) ON DELETE CASCADE,
        tool_id TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(run_id, tool_id)
      );
    `);
  }
  async flush() {
    await this.persist();
  }
  hasRun(owner: string, id: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM panel_runtime_runs WHERE id=? AND user_id=?")
        .get(id, owner),
    );
  }
  thread(owner: string, id: string): RuntimeThread {
    const row = this.db
      .prepare(
        "SELECT id,title,last_seq AS lastSeq,summary,summary_seq AS summarySeq,updated_at AS updatedAt FROM panel_runtime_threads WHERE id=? AND user_id=?",
      )
      .get(id, owner) as RuntimeThread | undefined;
    requireValue(row, 404, "THREAD_NOT_FOUND", "对话不存在或无权访问");
    return row;
  }
  list(owner: string, offset = 0) {
    return this.db
      .prepare(
        "SELECT id,title,last_seq AS lastSeq,summary_seq AS summarySeq,updated_at AS updatedAt FROM panel_runtime_threads WHERE user_id=? ORDER BY updated_at DESC,id LIMIT 50 OFFSET ?",
      )
      .all(owner, offset) as Omit<RuntimeThread, "summary">[];
  }
  run(owner: string, id: string): RuntimeRun {
    const run = parse<RuntimeRun>(
      this.db
        .prepare(
          "SELECT payload FROM panel_runtime_runs WHERE id=? AND user_id=?",
        )
        .get(id, owner),
    );
    requireValue(run, 404, "RUN_NOT_FOUND", "任务不存在或无权访问");
    return run;
  }
  active(owner: string): RuntimeRun | null {
    return parse<RuntimeRun>(
      this.db
        .prepare(
          "SELECT payload FROM panel_runtime_runs WHERE user_id=? AND status IN ('queued','running','compacting','waiting_approval') ORDER BY updated_at DESC LIMIT 1",
        )
        .get(owner),
    );
  }
  latest(owner: string, threadId: string): RuntimeRun | null {
    this.thread(owner, threadId);
    return parse<RuntimeRun>(
      this.db
        .prepare(
          "SELECT payload FROM panel_runtime_runs WHERE user_id=? AND thread_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1",
        )
        .get(owner, threadId),
    );
  }
  messages(
    owner: string,
    threadId: string,
    after = 0,
    limit = 100,
  ): RuntimeMessage[] {
    this.thread(owner, threadId);
    return (
      this.db
        .prepare(
          "SELECT payload,seq FROM panel_runtime_messages WHERE thread_id=? AND seq>? ORDER BY seq LIMIT ?",
        )
        .all(threadId, after, limit) as { payload: string; seq: number }[]
    ).map((row) => ({ ...JSON.parse(row.payload), seq: row.seq }));
  }
  message(owner: string, threadId: string, seq: number): RuntimeMessage {
    this.thread(owner, threadId);
    const row = this.db
      .prepare(
        "SELECT payload FROM panel_runtime_messages WHERE thread_id=? AND seq=?",
      )
      .get(threadId, seq);
    const message = parse<RuntimeMessage>(row);
    requireValue(message, 404, "MESSAGE_NOT_FOUND", "消息不存在");
    return { ...message, seq };
  }
  snapshot(owner: string, threadId: string, after?: number): RuntimeSnapshot {
    const thread = this.thread(owner, threadId);
    const cursor = after ?? Math.max(0, thread.lastSeq - 100);
    const messages = this.messages(owner, threadId, cursor, 100);
    const nextAfter = messages.at(-1)?.seq ?? cursor;
    return {
      thread,
      run: this.latest(owner, threadId),
      messages,
      nextAfter,
      hasMore: nextAfter < thread.lastSeq,
    };
  }
  private insertMessage(threadId: string, message: RuntimeMessage) {
    const existing = this.db
      .prepare(
        "SELECT payload FROM panel_runtime_messages WHERE thread_id=? AND id=?",
      )
      .get(threadId, message.id) as { payload: string } | undefined;
    const { seq: _seq, ...body } = message;
    const payload = JSON.stringify(body);
    if (existing) {
      requireValue(
        existing.payload === payload,
        409,
        "MESSAGE_CONFLICT",
        "消息标识已用于不同内容",
      );
      return;
    }
    this.db
      .prepare(
        "UPDATE panel_runtime_threads SET last_seq=last_seq+1,updated_at=? WHERE id=?",
      )
      .run(Date.now(), threadId);
    this.db
      .prepare(
        "INSERT INTO panel_runtime_messages(thread_id,seq,id,payload) SELECT id,last_seq,?,? FROM panel_runtime_threads WHERE id=?",
      )
      .run(message.id, payload, threadId);
  }
  async start(
    owner: string,
    input: StartRuntimeInput,
  ): Promise<{ run: RuntimeRun; created: boolean }> {
    const fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const result = this.db.transaction(() => {
      const old = this.db
        .prepare(
          "SELECT payload,fingerprint,user_id FROM panel_runtime_runs WHERE id=?",
        )
        .get(input.requestId) as
        | { payload: string; fingerprint: string; user_id: string }
        | undefined;
      if (old) {
        requireValue(
          old.user_id === owner && old.fingerprint === fingerprint,
          409,
          "REQUEST_CONFLICT",
          "请求标识重复且内容不同",
        );
        return { run: JSON.parse(old.payload) as RuntimeRun, created: false };
      }
      let threadId = input.threadId;
      if (threadId) {
        const thread = this.thread(owner, threadId);
        requireValue(
          input.expectedSeq === thread.lastSeq,
          409,
          "THREAD_CHANGED",
          "另一窗口更新了此对话，请重新打开后继续",
        );
        requireValue(
          !this.db
            .prepare(
              "SELECT 1 FROM panel_runtime_runs WHERE thread_id=? AND status IN ('queued','running','compacting','waiting_approval')",
            )
            .get(threadId),
          409,
          "RUN_ACTIVE",
          "此对话已有任务运行，请先停止或等待完成",
        );
      } else {
        threadId = crypto.randomUUID();
        this.db
          .prepare(
            "INSERT INTO panel_runtime_threads(id,user_id,title,updated_at) VALUES(?,?,?,?)",
          )
          .run(
            threadId,
            owner,
            input.message.content.trim().slice(0, 80) || "新对话",
            Date.now(),
          );
        for (const message of input.history ?? [])
          this.insertMessage(threadId, message);
      }
      this.insertMessage(threadId, input.message);
      const thread = this.thread(owner, threadId);
      const run: RuntimeRun = {
        id: input.requestId,
        threadId,
        status: "queued",
        userSeq: thread.lastSeq,
        targets: input.targets,
        options: input.options,
        pending: [],
        error: null,
        updatedAt: Date.now(),
        contextTokens: 0,
        contextWindow: 0,
      };
      this.db
        .prepare(
          "INSERT INTO panel_runtime_runs(id,thread_id,user_id,fingerprint,status,payload,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          run.id,
          threadId,
          owner,
          fingerprint,
          run.status,
          JSON.stringify(run),
          run.updatedAt,
        );
      return { run, created: true };
    })();
    await this.flush();
    return result;
  }
  async saveRun(
    owner: string,
    run: RuntimeRun,
    messages: RuntimeMessage[] = [],
  ): Promise<void> {
    requireValue(
      this.run(owner, run.id).threadId === run.threadId,
      409,
      "RUN_SCOPE",
      "Run thread changed",
    );
    this.db.transaction(() => {
      for (const message of messages) this.insertMessage(run.threadId, message);
      run.updatedAt = Date.now();
      this.db
        .prepare(
          "UPDATE panel_runtime_runs SET payload=?,status=?,updated_at=? WHERE id=? AND user_id=?",
        )
        .run(JSON.stringify(run), run.status, run.updatedAt, run.id, owner);
    })();
    await this.flush();
  }
  async summary(
    owner: string,
    threadId: string,
    expected: number,
    through: number,
    summary: string,
  ) {
    const thread = this.thread(owner, threadId);
    requireValue(
      through > expected && through <= thread.lastSeq,
      400,
      "SUMMARY_BOUNDARY",
      "摘要范围无效",
    );
    const result = this.db
      .prepare(
        "UPDATE panel_runtime_threads SET summary=?,summary_seq=? WHERE id=? AND user_id=? AND summary_seq=?",
      )
      .run(summary, through, threadId, owner, expected);
    requireValue(
      result.changes === 1,
      409,
      "SUMMARY_CONFLICT",
      "摘要期间对话已发生变化",
    );
    await this.flush();
  }
  jobs(owner: string, runId: string): RuntimeJob[] {
    this.run(owner, runId);
    return (
      this.db
        .prepare("SELECT payload FROM panel_runtime_jobs WHERE run_id=?")
        .all(runId) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload));
  }
  job(owner: string, id: string): RuntimeJob {
    const job = parse<RuntimeJob>(
      this.db
        .prepare(
          "SELECT j.payload FROM panel_runtime_jobs j JOIN panel_runtime_runs r ON j.run_id=r.id WHERE j.id=? AND r.user_id=?",
        )
        .get(id, owner),
    );
    requireValue(job, 404, "JOB_NOT_FOUND", "任务输出不存在或无权访问");
    return job;
  }
  async saveJob(owner: string, job: RuntimeJob) {
    this.run(owner, job.runId);
    this.db
      .prepare(
        "INSERT INTO panel_runtime_jobs(id,run_id,tool_id,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(job.id, job.runId, job.toolCallId, JSON.stringify(job));
    await this.flush();
  }
  async recoverInterrupted() {
    // Single application process owns execution. Never replay writes after a restart.
    this.db.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT id,payload FROM panel_runtime_runs WHERE status IN ('queued','running','compacting','waiting_approval')",
        )
        .all() as { id: string; payload: string }[];
      for (const row of rows) {
        const run: RuntimeRun = JSON.parse(row.payload);
        for (const call of run.pending)
          this.insertMessage(run.threadId, {
            id: crypto.randomUUID(),
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify({
              status: "interrupted",
              error:
                "Backend restarted; execution result unknown. Inspect job status before repeating work.",
            }),
          });
        run.pending = [];
        run.status = "interrupted";
        run.error =
          "服务重启，远端执行结果可能未知。请检查后再明确继续；不会自动重放命令。";
        this.db
          .prepare(
            "UPDATE panel_runtime_runs SET payload=?,status='interrupted' WHERE id=?",
          )
          .run(JSON.stringify(run), row.id);
      }
      const jobs = this.db
        .prepare(
          "SELECT id,payload FROM panel_runtime_jobs WHERE json_extract(payload,'$.status') IN ('starting','running')",
        )
        .all() as { id: string; payload: string }[];
      for (const row of jobs) {
        const job: RuntimeJob = JSON.parse(row.payload);
        if (job.status !== "starting" && job.status !== "running") continue;
        job.status = "interrupted";
        job.error = "远端状态未知，禁止自动重试执行";
        job.finishedAt = Date.now();
        this.db
          .prepare("UPDATE panel_runtime_jobs SET payload=? WHERE id=?")
          .run(JSON.stringify(job), job.id);
      }
    })();
    await this.flush();
  }
  async remove(owner: string, threadId: string) {
    this.thread(owner, threadId);
    requireValue(
      !this.db
        .prepare(
          "SELECT 1 FROM panel_runtime_runs WHERE thread_id=? AND status IN ('queued','running','compacting','waiting_approval')",
        )
        .get(threadId),
      409,
      "RUN_ACTIVE",
      "请先停止任务再删除对话",
    );
    const ids = (
      this.db
        .prepare(
          "SELECT j.id FROM panel_runtime_jobs j JOIN panel_runtime_runs r ON j.run_id=r.id WHERE r.thread_id=?",
        )
        .all(threadId) as { id: string }[]
    ).map((row) => row.id);
    this.db
      .prepare("DELETE FROM panel_runtime_threads WHERE id=? AND user_id=?")
      .run(threadId, owner);
    await this.flush();
    return ids;
  }
}
