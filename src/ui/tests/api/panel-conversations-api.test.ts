import { describe, it, expect, vi } from "vitest";
vi.mock("@/main-axios", () => ({
  authApi: { request: vi.fn(), get: vi.fn() },
}));
import {
  ConversationWriter,
  conversationApi,
  messageSnapshot,
} from "@/api/panel-conversations-api";
import type {
  PanelConversation,
  StoredChatMessage,
} from "@/types/panel-conversations";

const record = (): PanelConversation => ({
  id: "chat",
  hostId: 42,
  title: "chat",
  model: "",
  revision: 0,
  messageCount: 0,
  sizeBytes: 0,
  summary: "",
  summaryThrough: 0,
  createdAt: "now",
  updatedAt: "now",
});
const m = (id: string): StoredChatMessage => ({
  id,
  role: "user",
  content: id,
});

describe("conversation durable writer", () => {
  it("serializes overlapping flushes and appends only new messages", async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saved = record();
    const append = vi.fn(
      async (_id: string, revision: number, messages: StoredChatMessage[]) => {
        if (append.mock.calls.length === 1) await first;
        expect(revision).toBe(saved.revision);
        saved = {
          ...saved,
          revision: saved.revision + 1,
          messageCount: saved.messageCount + messages.length,
        };
        return saved;
      },
    );
    const notify = vi.fn();
    const writer = new ConversationWriter(record(), [], notify, {
      ...conversationApi,
      append,
    });
    const one = writer.flush([m("one")], "model");
    const two = writer.flush([m("one"), m("two")], "model");
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([one, two]);
    expect(append.mock.calls[1][2].map((message) => message.id)).toEqual([
      "two",
    ]);
    expect(writer.record.messageCount).toBe(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it("does not mark failed messages saved and can retry them", async () => {
    const append = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue({ ...record(), revision: 1, messageCount: 1 });
    const writer = new ConversationWriter(record(), [], vi.fn(), {
      ...conversationApi,
      append,
    });
    await expect(writer.flush([m("one")])).rejects.toThrow("disk full");
    expect(writer.record.messageCount).toBe(0);
    expect(writer.latest).toEqual([m("one")]);
    await writer.flush();
    expect(writer.record.messageCount).toBe(1);
    expect(append.mock.calls[1][2]).toEqual([m("one")]);
  });
  it("skips already loaded messages and detects unseen concurrent additions", async () => {
    const append = vi
      .fn()
      .mockResolvedValue({ ...record(), messageCount: 4, revision: 4 });
    const initial = { ...record(), messageCount: 1, revision: 1 };
    const writer = new ConversationWriter(initial, [m("old")], vi.fn(), {
      ...conversationApi,
      append,
    });
    await expect(writer.flush([m("old"), m("new")])).rejects.toThrow(
      "其他窗口",
    );
    expect(append.mock.calls[0][2]).toEqual([m("new")]);
    expect(writer.record).toEqual(initial);
  });
  it("keeps full text and attachments but strips UI-only error flags", () => {
    const original = {
      ...m("one"),
      error: "temporary UI error",
      content: "x".repeat(80_000),
      attachments: [
        {
          id: "img",
          name: "x.png",
          kind: "image" as const,
          size: 3,
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,YWJj",
        },
      ],
    };
    const snapshot = messageSnapshot(original);
    expect(snapshot.content.length).toBe(80_000);
    expect(snapshot.attachments?.[0].dataUrl).toBe(
      original.attachments[0].dataUrl,
    );
    expect(snapshot).not.toHaveProperty("error");
  });
  it("can finish a pending durable write after unmount without notifying a new component", async () => {
    const notify = vi.fn();
    const append = vi
      .fn()
      .mockResolvedValue({ ...record(), messageCount: 1, revision: 1 });
    const writer = new ConversationWriter(record(), [], notify, {
      ...conversationApi,
      append,
    });
    writer.dispose();
    await writer.flush([m("one")]);
    expect(append).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });
});
