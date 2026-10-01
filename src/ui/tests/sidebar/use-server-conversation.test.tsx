import { useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ConversationPage } from "@/types/panel-conversation";

vi.mock("@/api/panel-conversations-api", async () => {
  const { makeConversationApiFixture } = await import("./conversation-api-fixture");
  return { conversationApi: makeConversationApiFixture() };
});
import { conversationApi } from "@/api/panel-conversations-api";
import { useServerConversation, type ArchivedUiMessage } from "@/sidebar/use-server-conversation";
import { conversationRows, resetConversationRows } from "./conversation-api-fixture";

beforeEach(() => { vi.clearAllMocks(); resetConversationRows(); sessionStorage.clear(); localStorage.clear(); });
const mount = () => renderHook(() => {
  const [messages, setMessages] = useState<ArchivedUiMessage[]>([]);
  return { ...useServerConversation(setMessages), messages, setMessages };
});
const seed = async (id: string) => {
  const row = await conversationApi.create(id, `${id}-title`, []);
  return conversationApi.append(id, row.revision, [{ id: "u", role: "user", content: `original-${id}` }], []);
};

it("never automatically uploads unowned legacy browser history", async () => {
  localStorage.setItem("panelAgentLiveConversation", JSON.stringify({ messages: [{ role: "user", content: "old account data" }] }));
  const { result } = mount();
  await waitFor(() => expect(result.current.initialized).toBe(true));
  expect(result.current.messages).toEqual([]);
  expect(conversationApi.create).not.toHaveBeenCalled();
  expect(conversationApi.import).not.toHaveBeenCalled();
  expect(localStorage.getItem("panelAgentLiveConversation")).toContain("old account data");
});
it("restores stable message IDs from the server, keeping only owner-scoped pointer metadata in the browser", async () => {
  await seed("saved");
  const { result } = mount();
  await waitFor(() => expect(result.current.initialized).toBe(true));
  expect(result.current.messages[0]).toMatchObject({ id: "u", content: "original-saved", seq: 1 });
  expect(sessionStorage.getItem("panelAgentActiveConversation:test-user")).toBe("saved");
  expect(localStorage.getItem("panelAgentLiveConversation")).toBeNull();
});
it("retains unsaved visible content after a write fails and retries without duplicating records", async () => {
  const { result } = mount();
  await waitFor(() => expect(result.current.initialized).toBe(true));
  const messages: ArchivedUiMessage[] = [{ id: "u", role: "user", content: "do not lose" }];
  act(() => result.current.setMessages(messages));
  vi.mocked(conversationApi.append).mockRejectedValueOnce(new Error("quota"));
  await act(async () => { await expect(result.current.save(messages, [])).rejects.toThrow("quota"); });
  expect(result.current.messages).toEqual(messages);
  expect(result.current.error).toBe("quota");
  await act(async () => { await result.current.save(messages, []); });
  expect([...conversationRows.values()][0].messages).toHaveLength(1);
  expect(result.current.error).toBe("");
});
it("ignores an older open response that arrives after a newer conversation selection", async () => {
  const { result } = mount();
  await waitFor(() => expect(result.current.initialized).toBe(true));
  await seed("first"); await seed("second");
  const first = await conversationApi.page("first"), second = await conversationApi.page("second");
  let resolveFirst!: (value: ConversationPage) => void;
  let resolveSecond!: (value: ConversationPage) => void;
  vi.mocked(conversationApi.page).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
  let a!: Promise<void>, b!: Promise<void>;
  act(() => { a = result.current.open("first"); b = result.current.open("second"); });
  await act(async () => { resolveSecond(second); await b; });
  await act(async () => { resolveFirst(first); await a; });
  expect(result.current.record?.id).toBe("second");
  expect(result.current.messages[0].content).toBe("original-second");
});
it("does not delete or replace original messages during manual summary compaction", async () => {
  await seed("saved");
  const { result } = mount();
  await waitFor(() => expect(result.current.initialized).toBe(true));
  const original = result.current.messages;
  await act(async () => { await result.current.compact("model"); });
  expect(result.current.record?.summary).toBe("factual memory");
  expect(result.current.messages).toEqual(original);
  expect(conversationRows.get("saved")?.messages).toEqual(original);
});
it("honors an explicit new-chat pointer instead of silently reopening the last archived chat", async () => {
  await seed("saved");
  sessionStorage.setItem("panelAgentActiveConversation:test-user", "new");
  const { result } = mount();
  await waitFor(() => expect(result.current.initialized).toBe(true));
  expect(result.current.record).toBeNull();
  expect(result.current.messages).toEqual([]);
});
