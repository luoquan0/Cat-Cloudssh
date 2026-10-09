import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { ClientChannel } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeJobs, OutputSpool } from "./jobs.js";
import { RuntimeStore } from "./store.js";
import { sessionManager } from "../hosts/terminal/session-manager.js";
import type { RuntimeToolCall } from "../../types/panel-runtime.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});
class SharedChannel extends EventEmitter {
  writes: string[] = [];
  destroyed = false;
  autoComplete = true;
  destroy = vi.fn();
  end = vi.fn();
  write(value: string | Buffer) {
    const text = String(value);
    this.writes.push(text);
    if (text === "\x03") return true;
    const token = text.match(/cloudssh-agent-begin=([0-9a-f]+)/)?.[1];
    if (!token) return true;
    setTimeout(() => {
      const frame =
        `\x1b]777;cloudssh-agent-begin=${token}\x07UTF-8 中文未丢失` +
        (this.autoComplete
          ? `\x1b]777;cloudssh-agent-end=${token};status=0\x07`
          : "");
      // Force splits inside both UTF-8 characters and control markers.
      for (const byte of Buffer.from(frame))
        this.emit("data", Buffer.from([byte]));
    }, 1);
    return true;
  }
}
async function fixture(authorize = vi.fn(async () => {})) {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('alice')",
  );
  const store = new RuntimeStore(db);
  const sessionId = crypto.randomUUID();
  sessionManager.createSession("alice", 42, "test", 120, 40, undefined, false, {
    sessionId,
  });
  const session = sessionManager.getSession(sessionId)!;
  const channel = new SharedChannel();
  session.isConnected = true;
  session.sshStream = channel as unknown as ClientChannel;
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudssh-recovery-test-"),
  );
  cleanups.push(async () => {
    sessionManager.destroySession(sessionId);
    db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const { run } = await store.start("alice", {
    requestId: crypto.randomUUID(),
    message: { id: crypto.randomUUID(), role: "user", content: "inspect" },
    targets: [
      {
        targetId: "target",
        hostId: 42,
        hostName: "test",
        terminalSessionId: sessionId,
      },
    ],
    options: { sshMode: "shared-terminal" },
  });
  run.status = "running";
  const jobs = new RuntimeJobs(
    store,
    authorize,
    new OutputSpool(directory),
    vi.fn(),
  );
  async function nextCall() {
    const call: RuntimeToolCall = {
      id: crypto.randomUUID(),
      name: "run_command",
      arguments: { targetId: "target", command: "pwd" },
    };
    run.pending = [call];
    await store.saveRun("alice", run);
    return call;
  }
  return { jobs, run, session, channel, nextCall };
}

describe("shared-terminal recovery and cancellation", () => {
  it("a pre-dispatch authorization failure does not quarantine a healthy terminal", async () => {
    const authorize = vi
      .fn(async () => {})
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("permission changed"));
    const f = await fixture(authorize);
    const first = await f.jobs.start(
      "alice",
      f.run,
      await f.nextCall(),
      new AbortController().signal,
    );
    expect(first.status).toBe("interrupted");
    expect(f.channel.writes).toEqual([]);
    const second = await f.jobs.start(
      "alice",
      f.run,
      await f.nextCall(),
      new AbortController().signal,
    );
    expect(second.status).toBe("completed");
    expect((await f.jobs.spool.read(second.id, "stdout", 0, 1024)).text).toBe(
      "UTF-8 中文未丢失",
    );
    expect(f.channel.destroy).not.toHaveBeenCalled();
  });
  it("does not write a command or Ctrl-C when cancellation happens during authorization", async () => {
    const controller = new AbortController();
    let calls = 0;
    const f = await fixture(
      vi.fn(async () => {
        if (++calls === 2) controller.abort();
      }),
    );
    await f.jobs
      .start("alice", f.run, await f.nextCall(), controller.signal)
      .catch(() => undefined);
    await Promise.all(f.jobs.running(f.run.id).map((job) => job.done));
    expect(f.channel.writes).toEqual([]);
    expect(f.session.agentRuntimeLeaseId).toBeFalsy();
    const next = await f.jobs.start(
      "alice",
      f.run,
      await f.nextCall(),
      new AbortController().signal,
    );
    expect(next.status).toBe("completed");
  });
  it("retains the final output and blocks re-entry after an ambiguous cancellation", async () => {
    const f = await fixture();
    f.channel.autoComplete = false;
    const controller = new AbortController();
    const job = await f.jobs.start(
      "alice",
      f.run,
      await f.nextCall(),
      controller.signal,
    );
    expect(job.status).toBe("running");
    controller.abort();
    await Promise.all(f.jobs.running(f.run.id).map((item) => item.done));
    expect(f.session.isConnected).toBe(true);
    expect(f.session.agentRuntimeLeaseId).toBeFalsy();
    expect(f.channel.destroy).not.toHaveBeenCalled();
    expect((await f.jobs.spool.read(job.id, "stdout", 0, 1024)).text).toBe(
      "UTF-8 中文未丢失",
    );
    const writes = [...f.channel.writes];
    const next = await f.jobs.start(
      "alice",
      f.run,
      await f.nextCall(),
      new AbortController().signal,
    );
    expect(next.status).toBe("failed");
    expect(next.error).toContain("未收到 Shell 结束标记");
    expect(f.channel.writes).toEqual(writes);
  }, 10000);
});
