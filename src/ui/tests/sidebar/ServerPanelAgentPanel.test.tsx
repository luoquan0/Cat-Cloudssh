import { useEffect, useState } from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  cleanup,
} from "@testing-library/react";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { PanelConversationBridge } from "@/sidebar/PanelConversationBridge";
import type {
  PanelConversation,
  StoredChatMessage,
} from "@/types/panel-conversations";
import type { Tab } from "@/types/ui-types";

vi.mock("@/main-axios", () => ({
  authApi: { request: vi.fn(), get: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/sidebar/PanelAgentPanel", () => ({
  PanelAgentPanel: ({
    persistence: p,
  }: {
    persistence: PanelConversationBridge;
  }) => {
    const [messages, setMessages] = useState(p.initialMessages);
    const [draft, setDraft] = useState("");
    useEffect(() => {
      setMessages(p.initialMessages);
    }, [p.initialMessages]);
    useEffect(() => {
      p.onMessages(messages);
    }, [messages, p]);
    useEffect(() => {
      p.onModel("selected-model");
      p.onWorking(false);
    }, [p]);
    return (
      <div>
        {p.toolbar}
        {p.history}
        <span data-testid="bound-host">{p.hostId ?? "general"}</span>
        <input
          aria-label="draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          disabled={p.disabled}
          onClick={() => {
            const updated = [
              ...messages,
              { id: "new-message", role: "user" as const, content: draft },
            ];
            setMessages(updated);
            p.onMessages(updated);
            void p.flush(updated, "selected-model").catch(() => undefined);
          }}
        >
          Send test message
        </button>
        <button disabled={p.disabled} onClick={p.onNew}>
          New test conversation
        </button>
        <button disabled={p.disabled} onClick={p.onClear}>
          Delete current test conversation
        </button>
        {messages.map((message) => (
          <p key={message.id}>{message.content}</p>
        ))}
      </div>
    );
  },
}));
import { conversationApi } from "@/api/panel-conversations-api";
import { PanelAgentPanel } from "@/sidebar/ServerPanelAgentPanel";
import { conversationDefaultTarget } from "@/sidebar/conversation-target";

const msg = (id: string, content = id): StoredChatMessage => ({
  id,
  role: "user",
  content,
});
const metadata = (
  id: string,
  hostId: number | null = 42,
): PanelConversation => ({
  id,
  hostId,
  title: `History ${id}`,
  model: "model",
  revision: 1,
  messageCount: 1,
  sizeBytes: 20,
  summary: "",
  summaryThrough: 0,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
});
let records: PanelConversation[];
let messages: Map<string, StoredChatMessage[]>;
const tabs = [
  { id: "ssh42", host: { id: "42", name: "Server 42" } },
  { id: "ssh43", host: { id: "43", name: "Server 43" } },
] as Tab[];
beforeEach(() => {
  records = [metadata("first"), metadata("older")];
  messages = new Map(
    records.map((record) => [
      record.id,
      [msg(record.id, `${record.id} saved body`)],
    ]),
  );
  localStorage.clear();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(conversationApi, "list").mockImplementation(
    async (host, search = "") => ({
      conversations: records.filter(
        (r) =>
          (host === "all" || r.hostId === host) && r.title.includes(search),
      ),
      nextOffset: null,
    }),
  );
  vi.spyOn(conversationApi, "get").mockImplementation(async (id) => ({
    ...records.find((r) => r.id === id)!,
  }));
  vi.spyOn(conversationApi, "page").mockImplementation(async (id) => ({
    messages: messages.get(id) ?? [],
    nextBefore: null,
  }));
  vi.spyOn(conversationApi, "create").mockImplementation(
    async (hostId, title, id) => {
      const existing = records.find((r) => r.id === id);
      if (existing) return existing;
      const record = {
        ...metadata(id, hostId),
        title,
        messageCount: 0,
        revision: 0,
      };
      records.push(record);
      messages.set(id, []);
      return record;
    },
  );
  vi.spyOn(conversationApi, "append").mockImplementation(
    async (id, revision, batch) => {
      const record = records.find((r) => r.id === id)!;
      expect(revision).toBe(record.revision);
      const old = messages.get(id) ?? [];
      const novel = batch.filter(
        (m) => !old.some((prior) => prior.id === m.id),
      );
      messages.set(id, [...old, ...novel]);
      const updated = {
        ...record,
        revision: revision + (novel.length ? 1 : 0),
        messageCount: old.length + novel.length,
      };
      records = records.map((r) => (r.id === id ? updated : r));
      return updated;
    },
  );
  vi.spyOn(conversationApi, "remove").mockImplementation(async (id) => {
    records = records.filter((r) => r.id !== id);
    messages.delete(id);
  });
  vi.spyOn(conversationApi, "removeScope").mockImplementation(async (host) => {
    records = records.filter((r) => r.hostId !== host);
  });
  vi.spyOn(conversationApi, "compact").mockImplementation(async (id) => ({
    conversation: records.find((r) => r.id === id)!,
    compacted: false,
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount() {
  return render(<PanelAgentPanel terminalTabs={tabs} activeTabId="ssh42" />);
}
async function loaded() {
  await screen.findByText("first saved body");
  await waitFor(() =>
    expect(
      (screen.getByText("Send test message") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
}

describe("server history panel", () => {
  it("saves through the server even when browser storage is full", async () => {
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
    mount();
    await loaded();
    fireEvent.change(screen.getByLabelText("draft"), {
      target: { value: "new durable body" },
    });
    fireEvent.click(screen.getByText("Send test message"));
    await waitFor(() => expect(conversationApi.append).toHaveBeenCalledOnce());
    await screen.findByText(/已保存到服务器/);
    expect(storage).not.toHaveBeenCalled();
    expect(messages.get("first")?.at(-1)?.content).toBe("new durable body");
  });
  it("starts a new conversation without deleting the old one", async () => {
    mount();
    await loaded();
    fireEvent.click(screen.getByText("New test conversation"));
    await waitFor(() =>
      expect(screen.queryByText("first saved body")).toBeNull(),
    );
    expect(conversationApi.remove).not.toHaveBeenCalled();
    expect(records.find((r) => r.id === "first")).toBeTruthy();
  });
  it("cancelling deletion keeps the current record", async () => {
    mount();
    await loaded();
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByText("Delete current test conversation"));
    expect(conversationApi.remove).not.toHaveBeenCalled();
    expect(screen.getByText("first saved body")).toBeTruthy();
  });
  it("allows deleting old history while a new message cannot be saved due to quota", async () => {
    vi.mocked(conversationApi.append).mockRejectedValue(
      new Error("storage quota full"),
    );
    mount();
    await loaded();
    fireEvent.change(screen.getByLabelText("draft"), {
      target: { value: "unsaved body" },
    });
    fireEvent.click(screen.getByText("Send test message"));
    await screen.findByRole("alert");
    const olderRow = screen
      .getByText("History older")
      .closest("button")!.parentElement!;
    fireEvent.click(within(olderRow).getByText("删除"));
    await waitFor(() =>
      expect(conversationApi.remove).toHaveBeenCalledWith("older"),
    );
    expect(screen.getByText("unsaved body")).toBeTruthy();
    expect(conversationApi.append).toHaveBeenCalledTimes(1);
  });
  it("loads older messages without remounting or clearing a draft", async () => {
    vi.mocked(conversationApi.page).mockImplementation(async (_id, before) => ({
      messages: before
        ? [msg("earlier", "earlier body")]
        : [msg("first", "first saved body")],
      nextBefore: before ? null : 2,
    }));
    mount();
    await loaded();
    fireEvent.change(screen.getByLabelText("draft"), {
      target: { value: "keep my draft" },
    });
    fireEvent.click(screen.getByText("加载更早消息"));
    await screen.findByText("earlier body");
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe(
      "keep my draft",
    );
  });
  it("binds restored history to its server without issuing any commands", async () => {
    records.unshift(metadata("other-server", 43));
    messages.set("other-server", [msg("other-body")]);
    mount();
    await loaded();
    fireEvent.click(screen.getByText("显示所有服务器的对话（仅当前账号）"));
    await screen.findByText("History other-server");
    fireEvent.click(screen.getByText("History other-server"));
    await screen.findByText("other-body");
    expect(screen.getByTestId("bound-host").textContent).toBe("43");
    expect(conversationApi.append).not.toHaveBeenCalled();
    expect(conversationDefaultTarget(tabs, "ssh42", 43)?.id).toBe("ssh43");
    expect(conversationDefaultTarget(tabs, "ssh42", 44)).toBeUndefined();
    expect(conversationDefaultTarget(tabs, "ssh42", null)).toBeUndefined();
  });
  it("blocks unsaved chat fallback if server history could not load", async () => {
    vi.mocked(conversationApi.list).mockRejectedValue(
      new Error("history unavailable"),
    );
    mount();
    await screen.findByRole("alert");
    expect(
      (screen.getByText("Send test message") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("聊天归属服务器") as HTMLSelectElement).disabled,
    ).toBe(false);
    expect(conversationApi.create).not.toHaveBeenCalled();
  });
  it("imports legacy records only after confirmation and keeps the original browser data", async () => {
    const old = JSON.stringify([
      {
        id: "old-1",
        title: "my old conversation",
        messages: [{ role: "user", content: "legacy" }],
      },
    ]);
    localStorage.setItem("panelAgentConversationHistory", old);
    mount();
    await loaded();
    fireEvent.click(screen.getByText("导入浏览器旧记录"));
    await waitFor(() =>
      expect(conversationApi.create).toHaveBeenCalledWith(
        null,
        "my old conversation",
        "legacy-old-1",
      ),
    );
    await waitFor(() =>
      expect(messages.get("legacy-old-1")?.[0]?.content).toBe("legacy"),
    );
    expect(localStorage.getItem("panelAgentConversationHistory")).toBe(old);
  });
  it("uses the selected model for manual semantic compression", async () => {
    mount();
    await loaded();
    fireEvent.click(screen.getByText("压缩"));
    await waitFor(() =>
      expect(conversationApi.compact).toHaveBeenCalledWith(
        "first",
        1,
        "selected-model",
      ),
    );
  });
});
