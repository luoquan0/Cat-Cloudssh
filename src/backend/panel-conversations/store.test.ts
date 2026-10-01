import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationError, ConversationStore, parseMessages } from "./store.js";
import { modelContext, summarySource } from "./context.js";
import { persistedChat, type ConversationDependencies } from "./router.js";
import type { ConversationMessage } from "../../types/panel-conversation.js";

const message = (id: string, content = id, role: ConversationMessage["role"] = "user"): ConversationMessage => ({ id, role, content });
let db: Database.Database;
let store: ConversationStore;
let flush: ReturnType<typeof vi.fn>;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('a'),('b');");
  flush = vi.fn().mockResolvedValue(undefined);
  store = new ConversationStore(db, flush);
});
afterEach(() => db.close());

describe("personal conversation archive", () => {
  it("keeps original text and image data, and restores from the application DB snapshot", async () => {
    store.create("a", "chat", "Deploy", [{ hostId: 42 }]);
    const original: ConversationMessage = { ...message("u", "x".repeat(40_000)), attachments: [{ id: "picture", name: "plot.png", kind: "image", mimeType: "image/png", size: 6, dataUrl: "data:image/png;base64,YWJjZA==" }] };
    store.append("a", "chat", 0, [original]);
    await store.flush();
    expect(flush).toHaveBeenCalledOnce();
    const restoredDb = new Database(db.serialize());
    try {
      const restored = new ConversationStore(restoredDb);
      expect(restored.page("a", "chat").messages[0]).toMatchObject(original);
      expect(restored.get("a", "chat").hosts).toEqual([{ hostId: 42 }]);
    } finally { restoredDb.close(); }
  });

  it("does not allow another account, including an admin identity, to read or mutate a personal transcript", () => {
    store.create("a", "private", "private", []);
    store.append("a", "private", 0, [message("u")]);
    for (const action of [() => store.get("b", "private"), () => store.page("b", "private"), () => store.delete("b", "private", 1), () => store.append("b", "private", 1, [message("intruder")])]) expect(action).toThrow(ConversationError);
    expect(store.list("b").items).toEqual([]);
    store.deleteAll("b");
    expect(store.get("a", "private").messageCount).toBe(1);
  });

  it("deduplicates an acknowledged or lost-response append, rejects changed bodies, and detects concurrent writers", () => {
    store.create("a", "chat", "title", []);
    const first = store.append("a", "chat", 0, [message("u")]);
    expect(store.append("a", "chat", 0, [message("u")]).revision).toBe(first.revision);
    expect(() => store.append("a", "chat", first.revision, [message("u", "changed")])).toThrow("冲突");
    expect(() => store.append("a", "chat", 0, [message("other")])).toThrow("其他窗口");
    expect(store.page("a", "chat").messages).toHaveLength(1);
  });

  it("rejects storage pressure atomically instead of trimming or deleting the archive", () => {
    const small = new ConversationStore(db, flush, { conversationBytes: 180, userBytes: 300 });
    small.create("a", "small", "small", []);
    small.append("a", "small", 0, [message("one")]);
    const before = small.get("a", "small");
    expect(() => small.append("a", "small", before.revision, [message("two", "x".repeat(200))])).toThrow("存储达到上限");
    expect(small.get("a", "small")).toEqual(before);
    expect(small.page("a", "small").messages).toHaveLength(1);
  });

  it("handles host filters, full-text search, wildcard escaping and pagination", () => {
    for (let i = 0; i < 4; i += 1) {
      store.create("a", `c${i}`, `title-${i}`, [{ hostId: i % 2 + 1 }]);
      store.append("a", `c${i}`, 0, [message(`u${i}`, i === 0 ? "literal %_ needle" : "ordinary")]);
    }
    expect(store.list("a", { hostId: 1 }).items).toHaveLength(2);
    expect(store.list("a", { search: "%_" }).items).toHaveLength(1);
    expect(store.list("a", { search: "needle" }).items[0].id).toBe("c0");
    const first = store.list("a", { limit: 2 });
    const second = store.list("a", { limit: 2, offset: first.nextOffset! });
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
  });

  it("imports explicitly provided legacy records idempotently per user", () => {
    const a = store.import("a", "old", [message("u")], "browser-record");
    const again = store.import("a", "old", [message("u")], "browser-record");
    const b = store.import("b", "old", [message("u")], "browser-record");
    expect(again.id).toBe(a.id);
    expect(b.id).not.toBe(a.id);
    expect(store.list("a").items).toHaveLength(1);
  });

  it("compacts only the model context, preserving raw messages and complete recent tool pairs", () => {
    store.create("a", "chat", "title", []);
    const raw = Array.from({ length: 12 }, (_, i) => message(`m${i}`, `text-${i}`, i % 2 ? "assistant" : "user"));
    let record = store.append("a", "chat", 0, raw);
    const source = summarySource(store, "a", record)!;
    expect(source.through).toBe(8);
    record = store.summarize("a", "chat", record.revision, "A factual memory", source.through, "model");
    expect(store.messages("a", "chat")).toHaveLength(12);
    const context = modelContext(store, "a", record);
    expect(context[0].content).toContain("A factual memory");
    expect(context.some((item) => item.id === "m0")).toBe(false);
    expect(context.at(-1)?.id).toBe("m11");
    expect(store.message("a", "chat", "m0")?.content).toBe("text-0");
  });

  it("never invents or replays missing tool outcomes when resuming an interrupted chat", () => {
    store.create("a", "chat", "title", []);
    const record = store.append("a", "chat", 0, [message("u"), { ...message("a", "", "assistant"), toolCalls: [{ id: "call", name: "run_terminal_command", arguments: { command: "reboot" } }] }, message("u2", "continue")]);
    const context = modelContext(store, "a", record);
    expect(context.find((item) => item.id === "a")?.toolCalls).toBeUndefined();
    expect(context.find((item) => item.id === "a")?.content).toContain("不要自动重复执行");
    expect(store.message("a", "chat", "a")?.toolCalls).toHaveLength(1);
  });

  it("forks a retry without overwriting later messages in the original", () => {
    store.create("a", "chat", "title", [{ hostId: 42 }]);
    store.append("a", "chat", 0, [message("u"), message("a", "answer", "assistant"), message("u2")]);
    const child = store.fork("a", "chat", "u", "fork");
    expect(child.messageCount).toBe(1);
    expect(child.hosts).toEqual([{ hostId: 42 }]);
    expect(store.get("a", "chat").messageCount).toBe(3);
  });

  it("removes message payloads when a conversation or account is deleted", () => {
    for (const user of ["a", "b"]) {
      store.create(user, user, user, []);
      store.append(user, user, 0, [message("u")]);
    }
    store.delete("a", "a", 1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM panel_agent_conversation_messages").get()).toEqual({ n: 1 });
    db.prepare("DELETE FROM users WHERE id=?").run("b");
    expect(db.prepare("SELECT COUNT(*) AS n FROM panel_agent_conversation_messages").get()).toEqual({ n: 0 });
  });

  it("does not accept system messages or executable/external image URLs into archive messages", () => {
    expect(() => parseMessages([{ ...message("u"), role: "system" }])).toThrow();
    expect(() => parseMessages([{ ...message("u"), attachments: [{ id: "file", name: "x", kind: "image", mimeType: "image/png", size: 1, dataUrl: "https://untrusted.example/secret" }] }])).toThrow();
  });
});

describe("persisted model request", () => {
  const summary = vi.fn(async () => ({ text: "summary", model: "model" }));
  const deps = (): ConversationDependencies => ({ getStore: () => store, canAccessHost: async () => true });
  const complete = vi.fn(async () => ({ message: { role: "assistant" as const, content: "answer", toolCalls: [] } }));
  const seed = () => { store.create("a", "chat", "title", [{ hostId: 42 }]); return store.append("a", "chat", 0, [message("u")]); };
  it("saves replies before returning them and deduplicates a retried model request", async () => {
    complete.mockClear();
    const record = seed();
    const body = { conversationId: "chat", revision: record.revision, requestId: "request" };
    const result = await persistedChat(deps(), "a", body, [{ hostId: 42 }], "model", summary, complete);
    expect(store.message("a", "chat", result.message.id!)?.content).toBe("answer");
    expect(flush).toHaveBeenCalled();
    const retry = await persistedChat(deps(), "a", body, [{ hostId: 42 }], "model", summary, complete);
    expect(retry.replayed).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
  });
  it("rejects unbound SSH targets before invoking a model", async () => {
    const record = seed();
    const model = vi.fn();
    await expect(persistedChat(deps(), "a", { conversationId: "chat", revision: record.revision, requestId: "request" }, [{ hostId: 99 }], "model", summary, model)).rejects.toMatchObject({ code: "CONVERSATION_TARGET_MISMATCH" });
    expect(model).not.toHaveBeenCalled();
  });
  it("rechecks permission after a slow model request", async () => {
    const record = seed();
    let allowed = true;
    const dependencies = { getStore: () => store, canAccessHost: async () => allowed };
    await expect(persistedChat(dependencies, "a", { conversationId: "chat", revision: record.revision, requestId: "request" }, [{ hostId: 42 }], "model", summary, async () => {
      allowed = false;
      return { message: { role: "assistant", content: "private", toolCalls: [] } };
    })).rejects.toMatchObject({ code: "HOST_ACCESS_REVOKED" });
    expect(store.get("a", "chat").messageCount).toBe(1);
  });
  it("does not overwrite an append that arrived during generation", async () => {
    const record = seed();
    await expect(persistedChat(deps(), "a", { conversationId: "chat", revision: record.revision, requestId: "request" }, [], "model", summary, async () => {
      store.append("a", "chat", record.revision, [message("other", "other device")]);
      return { message: { role: "assistant", content: "stale answer", toolCalls: [] } };
    })).rejects.toMatchObject({ code: "CONVERSATION_CONFLICT" });
    expect(store.message("a", "chat", "other")?.content).toBe("other device");
    expect(store.get("a", "chat").messageCount).toBe(2);
  });
});
