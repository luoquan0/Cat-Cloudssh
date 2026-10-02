import crypto from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimeRun,
  RuntimeToolCall,
  StartRuntimeInput,
} from "../../types/panel-runtime.js";
import { RuntimeStore, RuntimeError } from "./store.js";
import { PanelRuntime } from "./runtime.js";
import type { RuntimeJobs } from "./jobs.js";
import type { RuntimeModel, RuntimeModelConfig } from "./model.js";
import {
  ContextBudget,
  completeGroups,
  fitToolEvidence,
  prepareContext,
} from "./context.js";
import { needsApproval, ProgressWatchdog } from "./policy.js";
import { parseStartRuntime } from "./input.js";

vi.mock("../hosts/host-resolver.js", () => ({ resolveHostById: vi.fn() }));
vi.mock("../hosts/file-manager/ssh-connection.js", () => ({
  attachDedicatedKeyboardInteractive: vi.fn(),
  buildDedicatedTransferConnectConfig: vi.fn(),
  startDedicatedTransferConnect: vi.fn(),
}));
const databases: Database.Database[] = [];
function store(persist?: () => Promise<void>) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('alice'),('bob');",
  );
  return new RuntimeStore(db, persist);
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});
function input(): StartRuntimeInput {
  return {
    requestId: crypto.randomUUID(),
    message: {
      id: crypto.randomUUID(),
      role: "user",
      content: "Inspect the server",
    },
    targets: [],
    options: {},
  };
}
const config: RuntimeModelConfig = {
  enabled: true,
  baseUrl: "https://example.invalid/v1",
  apiKey: "test",
  model: "test",
  temperature: 0,
  maxTokens: 1000,
  contextWindowTokens: 128000,
  multiServerEnabled: true,
  maxTargets: 4,
  skills: [],
};
function model(tool?: (n: number) => RuntimeToolCall | null): RuntimeModel {
  let turn = 0;
  return {
    complete: vi.fn(async () => {
      const call = tool?.(turn++);
      return {
        message: {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          content: call ? "Inspecting" : "Done",
          toolCalls: call ? [call] : [],
        },
        promptTokens: 0,
      };
    }),
    summarize: vi.fn(
      async () => "Prior observations. The current task is not complete.",
    ),
  };
}
function fakeJobs() {
  return {
    checkHealthy: vi.fn(),
    clearFailure: vi.fn(),
    start: vi.fn(async (_o, _r, call) => ({
      id: crypto.randomUUID(),
      targetId: "target",
      status: "completed",
      exitCode: 0,
      command: call.arguments.command,
    })),
    read: vi.fn(async () => ({
      status: "completed",
      exitCode: 0,
      stdout: "observed",
      stderr: "",
    })),
    running: vi.fn(() => []),
    stopRun: vi.fn(async () => {}),
    waitRun: vi.fn(async () => {}),
  };
}
async function finished(
  runtime: PanelRuntime,
  run: RuntimeRun,
  status = "completed",
) {
  await vi.waitFor(
    () => expect(runtime.store.run("alice", run.id).status).toBe(status),
    { timeout: 3000, interval: 5 },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
}
const tool = (command = "pwd"): RuntimeToolCall => ({
  id: "provider-id",
  name: "run_command",
  arguments: { targetId: "target", command },
});

describe("runtime durability and lifecycle", () => {
  it("accepts acknowledgement retries once and rejects changed payloads or another owner", async () => {
    const s = store();
    const request = input();
    const a = await s.start("alice", request);
    const b = await s.start("alice", request);
    expect(a.run.id).toBe(b.run.id);
    expect(b.created).toBe(false);
    expect(s.thread("alice", a.run.threadId).lastSeq).toBe(1);
    await expect(s.start("bob", request)).rejects.toMatchObject({
      code: "REQUEST_CONFLICT",
    });
    await expect(
      s.start("alice", {
        ...request,
        message: { ...request.message, content: "different" },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(() => s.thread("bob", a.run.threadId)).toThrow();
  });
  it("continues past 20 tool rounds when each command makes progress", async () => {
    const jobs = fakeJobs();
    const provider = model((n) => (n < 24 ? tool(`stat file-${n}`) : null));
    const runtime = new PanelRuntime(store(), jobs as unknown as RuntimeJobs, {
      config: async () => config,
      model: () => provider,
      watchdog: () => new ProgressWatchdog(5, 0),
    });
    const run = await runtime.start("alice", input(), async () => {});
    await finished(runtime, run);
    expect(jobs.start).toHaveBeenCalledTimes(24);
    expect(provider.complete).toHaveBeenCalledTimes(25);
    const messages = runtime.store.messages("alice", run.threadId, 0, 200);
    const ids = messages.flatMap(
      (message) => message.toolCalls?.map((call) => call.id) ?? [],
    );
    expect(new Set(ids).size).toBe(24);
  });
  it("pauses repeated identical output rather than stopping by total round count", async () => {
    const jobs = fakeJobs();
    const runtime = new PanelRuntime(store(), jobs as unknown as RuntimeJobs, {
      config: async () => config,
      model: () => model(() => tool()),
      watchdog: () => new ProgressWatchdog(5, 0),
    });
    const run = await runtime.start("alice", input(), async () => {});
    await finished(runtime, run, "paused");
    expect(jobs.start).toHaveBeenCalledTimes(5);
    expect(runtime.store.run("alice", run.id).pending).toEqual([]);
  });
  it("does not execute an unapproved command and handles a stale approval", async () => {
    const jobs = fakeJobs();
    const provider = model((n) =>
      n === 0 ? tool("touch requested-file") : null,
    );
    const runtime = new PanelRuntime(store(), jobs as unknown as RuntimeJobs, {
      config: async () => config,
      model: () => provider,
      watchdog: () => new ProgressWatchdog(5, 0),
    });
    const run = await runtime.start("alice", input(), async () => {});
    await vi.waitFor(() =>
      expect(runtime.store.run("alice", run.id).status).toBe(
        "waiting_approval",
      ),
    );
    expect(jobs.start).not.toHaveBeenCalled();
    const pending = runtime.store.run("alice", run.id).pending[0];
    await expect(
      runtime.approve("alice", run.id, "wrong-id", true, async () => {}),
    ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
    await runtime.approve("alice", run.id, pending.id, false, async () => {});
    await finished(runtime, run);
    expect(jobs.start).not.toHaveBeenCalled();
  });
  it("waits for explicit approval and rechecks authorization after waiting", async () => {
    const jobs = fakeJobs();
    const provider = model((n) =>
      n === 0 ? tool("touch requested-file") : null,
    );
    let authorized = true;
    const authorize = async () => {
      if (!authorized) throw new RuntimeError(403, "REVOKED", "revoked");
    };
    const runtime = new PanelRuntime(store(), jobs as unknown as RuntimeJobs, {
      config: async () => config,
      model: () => provider,
      watchdog: () => new ProgressWatchdog(5, 0),
    });
    const run = await runtime.start("alice", input(), authorize);
    await vi.waitFor(() =>
      expect(runtime.store.run("alice", run.id).status).toBe(
        "waiting_approval",
      ),
    );
    const call = runtime.store.run("alice", run.id).pending[0];
    authorized = false;
    await expect(
      runtime.approve("alice", run.id, call.id, true, authorize),
    ).rejects.toMatchObject({ status: 403 });
    await runtime.cancel("alice", run.id);
    expect(jobs.start).not.toHaveBeenCalled();
  });
  it("never executes a model tool if saving its intent failed", async () => {
    let fail = false;
    const s = store(async () => {
      if (fail) throw new Error("disk unavailable");
    });
    const jobs = fakeJobs();
    const provider = model(() => {
      fail = true;
      return tool();
    });
    const runtime = new PanelRuntime(s, jobs as unknown as RuntimeJobs, {
      config: async () => config,
      model: () => provider,
      watchdog: () => new ProgressWatchdog(5, 0),
    });
    const run = await runtime.start("alice", input(), async () => {});
    await finished(runtime, run, "paused");
    expect(jobs.start).not.toHaveBeenCalled();
  });
  it("a cancelled in-flight model response cannot cause a late command", async () => {
    const jobs = fakeJobs();
    let release!: () => void;
    const provider: RuntimeModel = {
      complete: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          message: {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            toolCalls: [tool()],
          },
          promptTokens: 0,
        };
      },
      summarize: async () => "summary",
    };
    const runtime = new PanelRuntime(store(), jobs as unknown as RuntimeJobs, {
      config: async () => config,
      model: () => provider,
    });
    const run = await runtime.start("alice", input(), async () => {});
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const stopping = runtime.cancel("alice", run.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await stopping;
    expect(jobs.start).not.toHaveBeenCalled();
    expect(runtime.store.run("alice", run.id).status).toBe("cancelled");
  });
  it("marks interrupted tool outcomes instead of replaying them after a restart", async () => {
    const s = store();
    const { run } = await s.start("alice", input());
    run.status = "running";
    run.pending = [tool()];
    await s.saveRun("alice", run, [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        toolCalls: run.pending,
      },
    ]);
    await s.recoverInterrupted();
    expect(s.run("alice", run.id).status).toBe("interrupted");
    expect(s.run("alice", run.id).pending).toEqual([]);
    expect(s.messages("alice", run.threadId).at(-1)?.content).toContain(
      "unknown",
    );
    expect(
      completeGroups(s.messages("alice", run.threadId)).flat(),
    ).toHaveLength(3);
  });
});

describe("context and input boundaries", () => {
  it("compacts old complete exchanges without deleting originals", async () => {
    const s = store();
    const { run } = await s.start("alice", input());
    for (let n = 0; n < 30; n++) {
      const call = { ...tool(`stat file-${n}`), id: crypto.randomUUID() };
      await s.saveRun("alice", run, [
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "observations ".repeat(100),
          toolCalls: [call],
        },
        {
          id: crypto.randomUUID(),
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({ stdout: "prior evidence ".repeat(100) }),
        },
      ]);
    }
    const count = s.thread("alice", run.threadId).lastSeq;
    const budget = new ContextBudget(12000, 1000, "test");
    const provider = model();
    const context = await prepareContext(
      s,
      "alice",
      run,
      [{ role: "system", content: "current task retained" }],
      provider,
      budget,
      new AbortController().signal,
      async () => {},
    );
    expect(context.tokens).toBeLessThanOrEqual(budget.inputLimit());
    expect(s.thread("alice", run.threadId).summarySeq).toBeGreaterThan(0);
    expect(s.thread("alice", run.threadId).lastSeq).toBe(count);
    expect(s.messages("alice", run.threadId, 0, 100)).toHaveLength(count);
    expect(provider.summarize).toHaveBeenCalled();
  });
  it("keeps evidence within the current token budget while preserving log references", () => {
    const budget = new ContextBudget(32768, 4000, "gpt-4o");
    const original = {
      jobId: crypto.randomUUID(),
      status: "completed",
      stdout: "long output ".repeat(10000),
      stderr: "details ".repeat(1000),
    };
    const result = fitToolEvidence(original, budget, 1000);
    expect(budget.count(result)).toBeLessThanOrEqual(1000);
    expect(result.jobId).toBe(original.jobId);
    expect(original.stdout.length).toBe(120000);
  });
  it("does not treat live job polling as a duplicate loop", () => {
    const watchdog = new ProgressWatchdog(5, 0);
    for (let n = 0; n < 100; n++)
      expect(
        watchdog.observe(
          { id: "poll", name: "read_job_output", arguments: { jobId: "job" } },
          { status: "running" },
        ),
      ).toBe(false);
  });
  it("requires approval for mutating arguments even on an otherwise familiar command", () => {
    expect(needsApproval(tool("pwd"))).toBe(false);
    for (const command of [
      "hostname new-host",
      "date --set=tomorrow",
      "uname -S changed",
      "tail -f app.log",
      "cat /dev/zero",
      "touch file",
    ])
      expect(needsApproval(tool(command))).toBe(true);
  });
  it("rejects client supplied tool calls and unconfirmed legacy imports", () => {
    const v = input();
    expect(parseStartRuntime(v).requestId).toBe(v.requestId);
    expect(() =>
      parseStartRuntime({
        ...v,
        message: { ...v.message, toolCalls: [tool()] },
      }),
    ).toThrow();
    expect(() => parseStartRuntime({ ...v, history: [] })).toThrow();
    expect(() =>
      parseStartRuntime({ ...v, targets: [{ targetId: "x", hostId: "bad" }] }),
    ).toThrow();
    expect(() =>
      parseStartRuntime({
        ...v,
        message: {
          ...v.message,
          attachments: [
            {
              id: crypto.randomUUID(),
              kind: "image",
              name: "remote",
              mimeType: "image/png",
              size: 10,
              dataUrl: "https://example.invalid/remote.png",
            },
          ],
        },
      }),
    ).toThrow();
  });
});
