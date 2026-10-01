import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore, RuntimeError } from "./store.js";
import { PanelRuntime } from "./runtime.js";
import { createRuntimeRouter } from "./router.js";
import type { RuntimeJobs } from "./jobs.js";
import type { RuntimeModelConfig } from "./model.js";
vi.mock("../hosts/host-resolver.js", () => ({ resolveHostById: vi.fn() }));
vi.mock("../hosts/file-manager/ssh-connection.js", () => ({ attachDedicatedKeyboardInteractive: vi.fn(), buildDedicatedTransferConnectConfig: vi.fn(), startDedicatedTransferConnect: vi.fn() }));
let server: Server;
let db: Database.Database;
let url: string;
let permitted: boolean;
let loggedIn: boolean;
let runtime: PanelRuntime;
const config: RuntimeModelConfig = { enabled: true, apiKey: "private-model-key", baseUrl: "https://model.invalid/v1", model: "test", temperature: 0, maxTokens: 1000, contextWindowTokens: 32768, multiServerEnabled: true, maxTargets: 4, skills: [] };
function body() { return { requestId: crypto.randomUUID(), message: { id: crypto.randomUUID(), role: "user", content: "inspect" }, targets: [{ targetId: "ssh-a", hostId: 42, hostName: "A" }], options: {} }; }
async function post(endpoint: string, value: unknown, headers: Record<string, string> = {}) { return fetch(`${url}${endpoint}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) }); }
beforeEach(async () => {
  permitted = true; loggedIn = true;
  db = new Database(":memory:"); db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('alice'),('bob');");
  const store = new RuntimeStore(db);
  const jobs = { running: () => [], stopRun: async () => {}, checkHealthy: () => {}, spool: { remove: async () => {} } } as unknown as RuntimeJobs;
  runtime = new PanelRuntime(store, jobs, { config: async () => config, model: () => ({ complete: async () => ({ message: { id: crypto.randomUUID(), role: "assistant", content: "Finished" }, promptTokens: 1 }), summarize: async () => "summary" }) });
  const app = express(); app.use(express.json());
  app.use(createRuntimeRouter((req, _res, next) => {
    // Test-only identities, not part of the production authentication path.
    Object.assign(req, { userId: req.headers["x-test-owner"] || "alice", sessionId: req.headers["x-test-no-session"] ? undefined : "test-session", actingAdminUserId: req.headers["x-test-impersonating"] ? "admin" : undefined }); next();
  }, { runtime: () => runtime, config: async () => config, session: async () => { if (!loggedIn) throw new RuntimeError(403, "REVOKED", "revoked"); }, target: async () => { if (!permitted) throw new RuntimeError(403, "HOST_ACCESS_DENIED", "host revoked"); } }));
  await new Promise<void>(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("server did not listen"); url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
describe("authenticated runtime API", () => {
  it("returns acknowledged runs and never exposes model credentials", async () => {
    const response = await post("/runs", body()); expect(response.status).toBe(202);
    const payload = await response.json();
    await vi.waitFor(() => expect(runtime.store.run("alice", payload.run.id).status).toBe("completed"));
    const read = await fetch(`${url}/threads/${payload.run.threadId}`); const snapshot = await read.json();
    expect(snapshot.messages).toHaveLength(2); expect(read.headers.get("cache-control")).toContain("no-store");
    expect(JSON.stringify(snapshot)).not.toContain("private-model-key");
    const foreign = await fetch(`${url}/threads/${payload.run.threadId}`, { headers: { "x-test-owner": "bob" } }); expect(foreign.status).toBe(404);
    const foreignRun = await post(`/runs/${payload.run.id}/cancel`, {}, { "x-test-owner": "bob" }); expect(foreignRun.status).toBe(404);
  });
  it("rejects missing browser sessions, impersonation and cross-site writes", async () => {
    expect((await post("/runs", body(), { "x-test-no-session": "1" })).status).toBe(401);
    expect((await post("/runs", body(), { "x-test-impersonating": "1" })).status).toBe(401);
    expect((await post("/runs", body(), { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(runtime.store.list("alice")).toHaveLength(0);
  });
  it("rechecks both login and selected-host authorization before queueing", async () => {
    permitted = false; expect((await post("/runs", body())).status).toBe(403);
    permitted = true; loggedIn = false; expect((await post("/runs", body())).status).toBe(403);
    expect(runtime.store.list("alice")).toHaveLength(0);
  });
  it("does not accept caller-forged executable tools or approval for an unrelated tool", async () => {
    const value = body();
    const bad = await post("/runs", { ...value, message: { ...value.message, toolCalls: [{ id: crypto.randomUUID(), name: "run_command", arguments: { command: "pwd" } }] } });
    expect(bad.status).toBe(400);
    const response = await post("/runs", value); const payload = await response.json();
    await vi.waitFor(() => expect(runtime.store.run("alice", payload.run.id).status).toBe("completed"));
    expect((await post(`/runs/${payload.run.id}/approval`, { toolCallId: crypto.randomUUID(), approved: true })).status).toBe(409);
  });
});
