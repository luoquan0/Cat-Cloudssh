import express from "express";
import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { Server } from "node:http";
import { createPanelConversationRouter } from "./panel-conversations.js";
import { PanelConversationRepository } from "../repositories/panel-conversation-repository.js";

let db: Database.Database;
let repo: PanelConversationRepository;
let server: Server;
let base: string;
const canAccessHost = vi.fn(async (_user: string, _host: number) => true);
const summarize = vi.fn(async () => "confirmed facts; outstanding work");
beforeEach(async () => {
  db = new Database(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('alice'),('bob');",
  );
  repo = new PanelConversationRepository(db);
  canAccessHost.mockReset().mockResolvedValue(true);
  summarize.mockReset().mockResolvedValue("confirmed facts; outstanding work");
  const app = express();
  app.use(express.json());
  app.use(
    "/conversations",
    createPanelConversationRouter({
      authenticate: (req, _res, next) => {
        if (req.headers["x-user"])
          Object.assign(req, { userId: req.headers["x-user"] });
        next();
      },
      repository: () => repo,
      canAccessHost,
      summarize,
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("listen failed");
  base = `http://127.0.0.1:${addr.port}/conversations`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});
const call = (path: string, method = "GET", body?: unknown, user = "alice") =>
  fetch(base + path, {
    method,
    headers: { "x-user": user, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function seed() {
  const record = await repo.create("alice", 42, "nginx", "chat");
  return repo.append(
    "alice",
    record.id,
    0,
    Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      role: "user",
      content: `message ${i}`,
    })),
  );
}

describe("server conversation API", () => {
  it("requires login and refuses cross-user reads, writes, export, summaries and deletion", async () => {
    await seed();
    expect((await fetch(base)).status).toBe(401);
    for (const [path, method, body] of [
      ["/chat", "GET", undefined],
      ["/chat/messages", "GET", undefined],
      ["/chat/context", "GET", undefined],
      ["/chat/export", "GET", undefined],
      ["/chat/compact", "POST", { revision: 1 }],
      ["/chat", "PATCH", { revision: 1, title: "x" }],
      ["/chat/messages", "POST", { revision: 1, messages: [] }],
      ["/chat", "DELETE", undefined],
    ] as const)
      expect((await call(path, method, body, "bob")).status).toBe(404);
    expect(summarize).not.toHaveBeenCalled();
    expect(repo.get("alice", "chat").messageCount).toBe(30);
  });
  it("checks host access and revocation without preventing owner data deletion", async () => {
    await seed();
    canAccessHost.mockResolvedValue(false);
    expect((await call("/chat")).status).toBe(403);
    expect((await call("", "POST", { hostId: 42, title: "new" })).status).toBe(
      403,
    );
    const listing = await call("?hostId=all");
    expect((await listing.json()).conversations).toHaveLength(0);
    expect((await call("/chat", "DELETE")).status).toBe(204);
  });
  it("persists a summary without deleting original records and exports the full transcript", async () => {
    const record = await seed();
    const response = await call("/chat/compact", "POST", {
      revision: record.revision,
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.compacted).toBe(true);
    expect(result.conversation.messageCount).toBe(30);
    const exported = await call("/chat/export");
    expect(exported.headers.get("cache-control")).toContain("no-store");
    const data = await exported.json();
    expect(data.messages).toHaveLength(30);
    expect(data.messages[0].content).toBe("message 0");
    expect(data.conversation.summary).toContain("confirmed facts");
  });
  it("keeps the original transcript if summary generation fails", async () => {
    const record = await seed();
    summarize.mockRejectedValue(new Error("provider down"));
    expect(
      (await call("/chat/compact", "POST", { revision: record.revision }))
        .status,
    ).toBe(500);
    expect(repo.get("alice", "chat").summary).toBe("");
    expect(repo.get("alice", "chat").revision).toBe(record.revision);
    expect(repo.page("alice", "chat").messages).toHaveLength(30);
  });
  it("rechecks permissions after the model call and does not save a revoked summary", async () => {
    const record = await seed();
    summarize.mockImplementation(async () => {
      canAccessHost.mockResolvedValue(false);
      return "summary";
    });
    expect(
      (await call("/chat/compact", "POST", { revision: record.revision }))
        .status,
    ).toBe(403);
    expect(repo.get("alice", "chat").summary).toBe("");
  });
  it("requires an explicit category confirmation for bulk deletion", async () => {
    await seed();
    await repo.create("alice", 43, "other");
    await repo.create("bob", 42, "private");
    expect((await call("", "DELETE", { hostId: 42 })).status).toBe(400);
    expect(
      (await call("", "DELETE", { confirmation: "DELETE_SCOPE" })).status,
    ).toBe(400);
    expect(
      (await call("", "DELETE", { confirmation: "DELETE_SCOPE", hostId: 42 }))
        .status,
    ).toBe(204);
    expect(repo.list("alice", undefined)).toHaveLength(1);
    expect(repo.list("bob", undefined)).toHaveLength(1);
  });
  it("rejects stale revisions, invalid page cursors and malformed message batches", async () => {
    await seed();
    expect((await call("/chat/messages?before=-1")).status).toBe(400);
    expect((await call("/chat", "PATCH", { title: "x" })).status).toBe(400);
    expect(
      (
        await call("/chat/messages", "POST", {
          revision: 0,
          messages: [{ id: "new", role: "user", content: "new" }],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("/chat/messages", "POST", {
          revision: 1,
          messages: [{ id: "invalid", role: "system", content: "bad" }],
        })
      ).status,
    ).toBe(400);
  });
});
