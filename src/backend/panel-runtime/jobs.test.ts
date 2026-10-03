import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { Client, ClientChannel } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimeJob,
  RuntimeRun,
  RuntimeToolCall,
} from "../../types/panel-runtime.js";
import { OutputSpool, RuntimeJobs, waitAtMost } from "./jobs.js";
import { RuntimeStore } from "./store.js";
import { sessionManager } from "../hosts/terminal/session-manager.js";

vi.mock("../hosts/host-resolver.js", () => ({ resolveHostById: vi.fn() }));
vi.mock("../hosts/file-manager/ssh-connection.js", () => ({
  attachDedicatedKeyboardInteractive: vi.fn(),
  buildDedicatedTransferConnectConfig: vi.fn(),
  startDedicatedTransferConnect: vi.fn(),
}));
const paths: string[] = [];
const databases: Database.Database[] = [];
const terminalSessions: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of terminalSessions.splice(0))
    sessionManager.destroySession(id);
  for (const db of databases.splice(0)) db.close();
  for (const directory of paths.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
async function spool(perJob = 8 * 1024 * 1024, total = 16 * 1024 * 1024) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudssh-output-test-"));
  paths.push(dir);
  return new OutputSpool(dir, perJob, total);
}
function job(): RuntimeJob {
  return {
    id: crypto.randomUUID(),
    runId: "run-id-123",
    toolCallId: "tool-id-123",
    targetId: "target",
    hostId: 42,
    command: "pwd",
    status: "running",
    exitCode: null,
    signal: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
}
async function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('alice'),('bob');",
  );
  const store = new RuntimeStore(db);
  const { run } = await store.start("alice", {
    requestId: crypto.randomUUID(),
    message: { id: crypto.randomUUID(), role: "user", content: "inspect" },
    targets: [{ targetId: "target", hostId: 42, hostName: "test" }],
    options: {},
  });
  const call: RuntimeToolCall = {
    id: crypto.randomUUID(),
    name: "run_command",
    arguments: { targetId: "target", command: "pwd" },
  };
  run.status = "running";
  run.pending = [call];
  await store.saveRun("alice", run);
  return { store, run, call };
}
class Channel extends Duplex {
  stderr = new PassThrough();
  signal = vi.fn();
  _read() {}
  _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error) => void,
  ) {
    callback();
  }
  close() {
    this.destroy();
  }
}
class Connection extends EventEmitter {
  channel = new Channel();
  exec = vi.fn(
    (
      _command: string,
      _options: unknown,
      callback: (error: Error | null, channel: Channel) => void,
    ) => {
      callback(null, this.channel);
      setTimeout(() => {
        this.channel.push(Buffer.from("hello stdout"));
        this.channel.stderr.write(Buffer.from("hello stderr"));
        this.channel.emit("exit", 0, null);
        this.channel.emit("close");
      }, 2);
    },
  );
  end() {
    this.emit("close");
  }
  destroy() {
    this.emit("close");
  }
}
describe("job output is separate from model context", () => {
  it("retains more than 2 MiB while returning only a requested page", async () => {
    const s = await spool();
    const j = job();
    await s.create(j.id);
    await s.append(j, "stdout", Buffer.alloc(3 * 1024 * 1024, 120));
    const page = await s.read(j.id, "stdout", 0, 1024);
    expect(page.text).toHaveLength(1024);
    expect(page.total).toBe(3 * 1024 * 1024);
    expect(j.stdoutBytes).toBe(page.total);
    await s.remove([j.id]);
    expect((await s.read(j.id, "stdout", 0, 10)).total).toBe(0);
  });
  it("keeps stdout and stderr offsets independent and enforces physical capacity", async () => {
    const s = await spool(10, 10);
    const j = job();
    await s.create(j.id);
    await s.append(j, "stdout", Buffer.from("abcde"));
    await s.append(j, "stderr", Buffer.from("XYZ"));
    expect(await s.read(j.id, "stdout", 1, 2)).toMatchObject({
      text: "bc",
      offset: 1,
      nextOffset: 3,
      total: 5,
    });
    expect(await s.read(j.id, "stderr", 0, 2, true)).toMatchObject({
      text: "YZ",
      offset: 1,
      nextOffset: 3,
    });
    await expect(
      s.append(j, "stdout", Buffer.from("extra")),
    ).rejects.toMatchObject({ code: "OUTPUT_STORAGE_LIMIT" });
    expect(j.stdoutBytes).toBe(5);
  });
  it("rejects path traversal and symbolic-link log targets", async () => {
    const s = await spool();
    await expect(s.create("../../outside")).rejects.toThrow();
    const id = crypto.randomUUID();
    const dest = path.join(s.root, "owned.txt");
    await fs.writeFile(dest, "preserve");
    await fs.symlink(dest, path.join(s.root, `${id}.stdout`));
    await expect(s.read(id, "stdout", 0, 100)).rejects.toThrow();
    expect(await fs.readFile(dest, "utf8")).toBe("preserve");
  });
  it("removes delay abort listeners when a fast job completes", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await waitAtMost(Promise.resolve(), 60000, controller.signal);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
describe("independent execution", () => {
  it("uses non-PTY exec, returns real exit status and deduplicates acknowledgement retries", async () => {
    const { store, run, call } = await fixture();
    const connection = new Connection();
    const connect = vi.fn(async () => connection as unknown as Client);
    const jobs = new RuntimeJobs(store, async () => {}, await spool(), connect);
    const first = await jobs.start(
      "alice",
      run,
      call,
      new AbortController().signal,
    );
    expect(first.status).toBe("completed");
    expect(first.exitCode).toBe(0);
    expect(connection.exec).toHaveBeenCalledWith(
      "pwd",
      { pty: false },
      expect.any(Function),
    );
    const output = await jobs.read(
      "alice",
      run,
      first.id,
      {},
      2048,
      new AbortController().signal,
    );
    expect(output).toMatchObject({
      stdout: "hello stdout",
      stderr: "hello stderr",
      exitCode: 0,
    });
    const second = await jobs.start(
      "alice",
      run,
      call,
      new AbortController().signal,
    );
    expect(second.id).toBe(first.id);
    expect(connect).toHaveBeenCalledOnce();
    await expect(
      jobs.read("bob", run, first.id, {}, 100, new AbortController().signal),
    ).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
  });
  it("refuses unselected targets and unknown writes before establishing SSH", async () => {
    const { store, run, call } = await fixture();
    const connect = vi.fn();
    const jobs = new RuntimeJobs(store, async () => {}, await spool(), connect);
    const malicious = {
      ...call,
      arguments: { targetId: "unselected", command: "pwd" },
    };
    run.pending = [malicious];
    await store.saveRun("alice", run);
    await expect(
      jobs.start("alice", run, malicious, new AbortController().signal),
    ).rejects.toMatchObject({ code: "TARGET_NOT_SELECTED" });
    const mutation = {
      ...call,
      arguments: { targetId: "target", command: "touch requested-file" },
    };
    run.pending = [mutation];
    await store.saveRun("alice", run);
    await expect(
      jobs.start("alice", run, mutation, new AbortController().signal),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(connect).not.toHaveBeenCalled();
  });
  it("rejects revoked host access and cross-run output reads", async () => {
    const { store, run, call } = await fixture();
    const connect = vi.fn();
    const jobs = new RuntimeJobs(
      store,
      async () => {
        throw new Error("revoked");
      },
      await spool(),
      connect,
    );
    await expect(
      jobs.start("alice", run, call, new AbortController().signal),
    ).rejects.toThrow("revoked");
    expect(connect).not.toHaveBeenCalled();
    const j = { ...job(), runId: run.id };
    await store.saveJob("alice", j);
    await expect(
      jobs.read(
        "alice",
        { ...run, id: "other-run" } as RuntimeRun,
        j.id,
        {},
        100,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "JOB_SCOPE" });
  });
});

describe("shared terminal execution", () => {
  it("uses the selected live PTY instead of opening a second SSH connection", async () => {
    const { store, run, call } = await fixture();
    const sessionId = "terminal-session-123";
    terminalSessions.push(sessionId);
    sessionManager.createSession(
      "alice",
      42,
      "test",
      120,
      40,
      undefined,
      false,
      { sessionId },
    );
    const session = sessionManager.getSession(sessionId)!;
    class SharedChannel extends Duplex {
      stderr = new PassThrough();
      writes: string[] = [];
      _read() {}
      _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ) {
        const text = chunk.toString("utf8");
        this.writes.push(text);
        callback();
        if (text === "\u0003") return;
        const token = text.match(/cloudssh-agent-begin=([0-9a-f]+)/)?.[1];
        if (!token) return;
        setTimeout(() => {
          this.push(
            Buffer.from(
              `\u001b]777;cloudssh-agent-begin=${token}\u0007shared output\r\n\u001b]777;cloudssh-agent-end=${token};status=0\u0007`,
            ),
          );
        }, 2);
      }
    }
    const channel = new SharedChannel();
    session.isConnected = true;
    session.sshStream = channel as unknown as ClientChannel;
    run.options = { sshMode: "shared-terminal" };
    run.targets = [
      {
        targetId: "target",
        hostId: 42,
        hostName: "test",
        terminalSessionId: sessionId,
      },
    ];
    await store.saveRun("alice", run);

    const connect = vi.fn();
    const jobs = new RuntimeJobs(store, async () => {}, await spool(), connect);
    const result = await jobs.start(
      "alice",
      run,
      call,
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(connect).not.toHaveBeenCalled();
    expect(channel.writes.join("")).toContain("eval 'pwd'");
    expect(session.agentRuntimeLeaseId).toBeNull();

    const output = await jobs.read(
      "alice",
      run,
      result.id,
      {},
      2048,
      new AbortController().signal,
    );
    expect(output.stdout).toContain("shared output");
  });
});
