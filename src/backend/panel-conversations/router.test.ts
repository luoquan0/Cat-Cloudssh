import Database from "better-sqlite3";
import express from "express";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createConversationRouter } from "./router.js";
import { ConversationError, ConversationStore } from "./store.js";

let server: Server;
let db: Database.Database;
let store: ConversationStore;
let base: string;
let allowed: boolean;
let summarize: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  allowed = true;
  db = new Database(":memory:");
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('a'),('b')");
  store = new ConversationStore(db);
  summarize = vi.fn().mockResolvedValue({ text: "summary", model: "model" });
  const app = express();
  app.use(express.json({ limit: "40mb" }));
  app.use(createConversationRouter({ getStore: () => store, canAccessHost: async () => allowed }, (req, _res, next) => {
    if (req.header("x-test-user")) Object.assign(req, { userId: req.header("x-test-user") });
    next();
  }, summarize));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const e = error as ConversationError;
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });
const call = (path: string, method = "GET", body?: unknown, owner = "a") => fetch(base + path, {
  method, headers: { "content-type": "application/json", ...(owner ? { "x-test-user": owner } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const seed = () => {
  store.create("a", "private", "personal record", [{ hostId: 42 }]);
  return store.append("a", "private", 0, [{ id: "u", role: "user", content: "private content" }]);
};

it("requires login for every conversation route", async () => {
  for (const [path, method] of [["/", "GET"], ["/", "POST"], ["/import", "POST"], ["/private", "GET"], ["/private/export", "GET"], ["/private/compact", "POST"], ["/", "DELETE"]]) {
    expect((await call(path, method, method === "GET" ? undefined : {}, "")).status).toBe(401);
  }
});
it("scopes search, reads, exports and mutations to the authenticated owner", async () => {
  seed();
  const list = await (await call("/", "GET", undefined, "b")).json();
  expect(list.items).toEqual([]);
  for (const [path, method, body] of [["/private", "GET", undefined], ["/private/export", "GET", undefined], ["/private", "PATCH", { revision: 1, title: "hijack" }], ["/private", "DELETE", { revision: 1 }], ["/private/messages", "POST", { revision: 1, messages: [] }], ["/private/compact", "POST", { revision: 1 }]] as const) {
    expect((await call(path, method, body, "b")).status).toBe(404);
  }
  expect(summarize).not.toHaveBeenCalled();
});
it("checks host permission on create and hides revoked records without exposing their contents", async () => {
  seed(); allowed = false;
  expect((await call("/", "POST", { id: "new", title: "new", hosts: [{ hostId: 42 }] })).status).toBe(403);
  expect((await (await call("/")).json()).items).toEqual([]);
  expect((await call("/private/export")).status).toBe(403);
  expect((await call("/private/compact", "POST", { revision: 1 })).status).toBe(403);
  // The owner can still remove their data without regaining host access.
  expect((await call("/private", "DELETE", { revision: 1 })).status).toBe(204);
});
it("exports full raw records with no-store and does not mutate them when summarization fails", async () => {
  seed();
  let row = store.get("a", "private");
  row = store.append("a", "private", row.revision, Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "user" : "assistant", content: `original-${i}` })));
  summarize.mockRejectedValueOnce(new ConversationError("provider unavailable", 502));
  expect((await call("/private/compact", "POST", { revision: row.revision })).status).toBe(502);
  expect(store.get("a", "private")).toEqual(row);
  const response = await call("/private/export");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const data = await response.json();
  expect(data.messages).toHaveLength(9);
  expect(data.messages[0].content).toBe("private content");
});
it("requires explicit ownership confirmation for legacy import and explicit confirmation for bulk deletion", async () => {
  const payload = { legacyId: "old", title: "legacy", messages: [{ id: "u", role: "user", content: "original" }] };
  expect((await call("/import", "POST", payload)).status).toBe(400);
  expect((await call("/import", "POST", { ...payload, confirmOwnership: true })).status).toBe(201);
  expect((await call("/", "DELETE", {})).status).toBe(400);
  expect(store.list("a").items).toHaveLength(1);
  store.create("b", "other", "other", []);
  expect((await (await call("/", "DELETE", { confirm: "delete-all" })).json()).deleted).toBe(1);
  expect(store.list("b").items).toHaveLength(1);
});
it("revalidates permissions and revisions after summary generation", async () => {
  seed();
  const row = store.append("a", "private", 1, Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "user" : "assistant", content: `text-${i}` })));
  summarize.mockImplementationOnce(async () => { allowed = false; return { text: "private summary", model: "model" }; });
  expect((await call("/private/compact", "POST", { revision: row.revision })).status).toBe(403);
  expect(store.get("a", "private").summary).toBe("");
});
