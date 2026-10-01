import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { PanelConversationRepository } from "./panel-conversation-repository.js";
import type { StoredChatMessage } from "../../../types/panel-conversations.js";

describe("long active Agent turn", () => {
  it("keeps the active user instruction and complete tool pairs beyond 160 messages", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        "PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('alice');",
      );
      const repo = new PanelConversationRepository(db);
      const record = await repo.create("alice", 42, "long-running diagnosis");
      const messages: StoredChatMessage[] = [
        {
          id: "user",
          role: "user",
          content: "inspect this server without changing it",
        },
      ];
      for (let i = 0; i < 90; i++)
        messages.push(
          {
            id: `assistant-${i}`,
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: `call-${i}`,
                name: "read_terminal_context",
                arguments: { targetId: "ssh42" },
              },
            ],
          },
          {
            id: `result-${i}`,
            role: "tool",
            toolCallId: `call-${i}`,
            content: `observed ${i}`,
          },
        );
      await repo.append("alice", record.id, 0, messages);
      const context = repo.context("alice", record.id);
      expect(context.omittedMessages).toBe(0);
      expect(context.messages[0]).toEqual(messages[0]);
      expect(context.messages).toHaveLength(181);
      expect(context.messages.at(-1)?.id).toBe("result-89");
      expect(JSON.stringify(context.messages)).not.toContain(
        "RESULT_NOT_RECORDED",
      );
      expect(
        repo.page("alice", record.id, undefined, 200).messages,
      ).toHaveLength(181);
    } finally {
      db.close();
    }
  });
});
