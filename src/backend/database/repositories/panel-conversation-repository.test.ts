import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  PanelConversationRepository,
  validateStoredMessages,
} from "./panel-conversation-repository.js";
import { repairRecordedToolTurns } from "./panel-conversation-context.js";
import type { StoredChatMessage } from "../../../types/panel-conversations.js";

let db: Database.Database;
let repo: PanelConversationRepository;
const message = (id: string, content = "hello"): StoredChatMessage => ({
  id,
  role: "user",
  content,
});
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('alice'), ('bob');",
  );
  repo = new PanelConversationRepository(db);
});
afterEach(() => db.close());

describe("durable panel conversations", () => {
  it("isolates users, server scopes and paginates without losing older messages", async () => {
    const a = await repo.create("alice", 1, "nginx", "a");
    await repo.create("alice", 2, "docker", "b");
    await repo.create("bob", 1, "private", "a");
    expect(repo.list("alice", 1).map((c) => c.title)).toEqual(["nginx"]);
    expect(repo.list("alice", undefined, "docker")).toHaveLength(1);
    expect(() => repo.get("bob", "b")).toThrow();
    const messages = Array.from({ length: 150 }, (_, i) => message(`m-${i}`));
    await repo.append("alice", a.id, 0, messages, "model-a");
    const page = repo.page("alice", a.id);
    expect(page.messages).toHaveLength(100);
    expect(page.nextBefore).toBe(51);
    expect(repo.page("alice", a.id, page.nextBefore!).messages).toHaveLength(
      50,
    );
    expect(repo.page("bob", "a").messages).toHaveLength(0);
  });
  it("retries a lost acknowledgement without duplicating messages", async () => {
    const a = await repo.create("alice", null, "chat", "retry");
    const first = await repo.append("alice", a.id, 0, [message("one")]);
    const retry = await repo.append("alice", a.id, 0, [message("one")]);
    expect(retry.messageCount).toBe(1);
    expect(retry.revision).toBe(first.revision);
    await expect(
      repo.append("alice", a.id, first.revision, [
        message("one", "overwritten"),
      ]),
    ).rejects.toThrow("不能覆盖");
    expect(repo.page("alice", a.id).messages[0].content).toBe("hello");
  });
  it("rejects concurrent stale writes and does not recreate deleted conversations", async () => {
    const a = await repo.create("alice", null, "chat");
    await repo.append("alice", a.id, 0, [message("one")]);
    await expect(
      repo.append("alice", a.id, 0, [message("two")]),
    ).rejects.toMatchObject({ status: 409 });
    await repo.delete("alice", a.id);
    await expect(
      repo.append("alice", a.id, 1, [message("two")]),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      db.prepare("SELECT count(*) AS n FROM panel_conversation_messages").get(),
    ).toEqual({ n: 0 });
  });
  it("retries durability hooks even when a prior write reached memory but failed to save", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    repo = new PanelConversationRepository(db, save);
    const a = await repo.create("alice", null, "chat", "durable");
    save.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      repo.append("alice", a.id, 0, [message("one")]),
    ).rejects.toThrow("disk full");
    await repo.append("alice", a.id, 0, [message("one")]);
    expect(save).toHaveBeenCalledTimes(3);
    expect(repo.get("alice", a.id).messageCount).toBe(1);
  });
  it("retains original attachment contents without putting them in older model context", async () => {
    const a = await repo.create("alice", 1, "images");
    const attached = {
      ...message("image"),
      attachments: [
        {
          id: "img",
          name: "x.png",
          kind: "image" as const,
          mimeType: "image/png",
          size: 3,
          dataUrl: "data:image/png;base64,YWJj",
        },
      ],
    };
    await repo.append("alice", a.id, 0, [attached, message("next")]);
    expect(repo.page("alice", a.id).messages[0].attachments?.[0].dataUrl).toBe(
      attached.attachments[0].dataUrl,
    );
    expect(JSON.stringify(repo.context("alice", a.id).messages)).not.toContain(
      "base64",
    );
  });
  it("summarizes complete earlier turns without modifying any original message", async () => {
    const a = await repo.create("alice", 1, "long");
    const originals = Array.from({ length: 40 }, (_, i) => ({
      ...message(`m${i}`, "x".repeat(8000)),
      role: i % 2 ? ("assistant" as const) : ("user" as const),
    }));
    const saved = await repo.append("alice", a.id, 0, originals);
    const input = repo.compactionInput("alice", a.id)!;
    expect(input.through).toBeGreaterThan(0);
    expect(input.through).toBeLessThanOrEqual(28);
    await repo.saveSummary(
      "alice",
      a.id,
      saved.revision,
      input.through,
      "nginx installed; restart unconfirmed",
    );
    expect(repo.page("alice", a.id).messages).toMatchObject(originals);
    const current = repo.get("alice", a.id);
    expect(current.messageCount).toBe(40);
    expect(current.summaryThrough).toBe(input.through);
    expect(repo.context("alice", a.id).messages[0].content).toContain(
      "restart unconfirmed",
    );
  });
  it("does not commit an empty or stale summary", async () => {
    const a = await repo.create("alice", null, "summary");
    const saved = await repo.append(
      "alice",
      a.id,
      0,
      Array.from({ length: 20 }, (_, i) => message(`m${i}`)),
    );
    await expect(
      repo.saveSummary("alice", a.id, saved.revision, 2, ""),
    ).rejects.toThrow();
    await repo.append("alice", a.id, saved.revision, [message("later")]);
    await expect(
      repo.saveSummary("alice", a.id, saved.revision, 2, "summary"),
    ).rejects.toMatchObject({ status: 409 });
    expect(repo.get("alice", a.id).summary).toBe("");
    expect(repo.get("alice", a.id).messageCount).toBe(21);
  });
  it("rejects quota overflows rather than silently pruning stored history", async () => {
    const a = await repo.create("alice", null, "quota");
    db.prepare("UPDATE panel_conversations SET size_bytes=? WHERE id=?").run(
      64 * 1024 * 1024,
      a.id,
    );
    await expect(
      repo.append("alice", a.id, 0, [message("one")]),
    ).rejects.toMatchObject({ code: "CONVERSATION_QUOTA" });
    expect(repo.get("alice", a.id).messageCount).toBe(0);
    expect(() =>
      validateStoredMessages([message("too-long", "x".repeat(1_000_001))]),
    ).toThrow();
    expect(() =>
      validateStoredMessages([message("same"), message("same")]),
    ).toThrow();
  });
  it("supports database snapshot restart and user deletion cascade", async () => {
    const a = await repo.create("alice", 1, "restart");
    await repo.append("alice", a.id, 0, [message("one")]);
    const restored = new Database(db.serialize());
    const reopened = new PanelConversationRepository(restored);
    expect(reopened.page("alice", a.id).messages[0].content).toBe("hello");
    restored.close();
    db.prepare("DELETE FROM users WHERE id=?").run("alice");
    expect(repo.list("alice", undefined)).toHaveLength(0);
    expect(
      db.prepare("SELECT count(*) AS n FROM panel_conversation_messages").get(),
    ).toEqual({ n: 0 });
  });
  it("bulk deletion affects only the selected user's host scope", async () => {
    await repo.create("alice", 1, "one");
    await repo.create("alice", 2, "two");
    await repo.create("bob", 1, "bob");
    await repo.deleteScope("alice", 1);
    expect(repo.list("alice", undefined).map((c) => c.hostId)).toEqual([2]);
    expect(repo.list("bob", undefined)).toHaveLength(1);
  });
});

describe("interrupted tool history", () => {
  it("adds an explicit unknown outcome to the request only, never executes or mutates stored commands", () => {
    const original: StoredChatMessage[] = [
      message("user"),
      {
        id: "answer",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "run_terminal_command",
            arguments: { command: "apt upgrade" },
          },
        ],
      },
      message("next", "continue"),
    ];
    const repaired = repairRecordedToolTurns(original);
    expect(repaired[2].role).toBe("tool");
    expect(repaired[2].content).toContain("RESULT_NOT_RECORDED");
    expect(repaired[3].id).toBe("next");
    expect(original).toHaveLength(3);
  });
  it("keeps completed tool calls paired", () => {
    const original: StoredChatMessage[] = [
      message("user"),
      {
        id: "answer",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-1", name: "read_terminal_context", arguments: {} },
        ],
      },
      { id: "result", role: "tool", toolCallId: "call-1", content: "observed" },
    ];
    expect(repairRecordedToolTurns(original)).toEqual(original);
  });
});
