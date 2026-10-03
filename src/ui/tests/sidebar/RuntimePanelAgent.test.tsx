import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/types/ui-types";
import type {
  RuntimeRun,
  RuntimeSnapshot,
  StartRuntimeInput,
} from "@/types/panel-runtime";
const api = vi.hoisted(() => ({
  start: vi.fn(),
  active: vi.fn(),
  run: vi.fn(),
  snapshot: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  approve: vi.fn(),
  output: vi.fn(),
}));
const model = vi.hoisted(() => ({
  getPanelAgentSettings: vi.fn(),
  getPanelAgentModels: vi.fn(),
  sendPanelAgentChat: vi.fn(),
}));
vi.mock("@/api/panel-runtime-api", () => ({ runtimeApi: api }));
vi.mock("@/api/panel-agent-api", () => model);
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
import { createMessageId } from "@/sidebar/PanelAgentPanel";
import {
  createRuntimeClientId,
  RuntimePanelAgent,
} from "@/sidebar/RuntimePanelAgent";
import { RuntimeToolCard } from "@/sidebar/RuntimeToolCard";
let snapshot: RuntimeSnapshot;
function makeRun(status: RuntimeRun["status"] = "completed"): RuntimeRun {
  return {
    id: "run-12345678",
    threadId: "thread-12345678",
    status,
    userSeq: 1,
    targets: [],
    options: {},
    pending: [],
    error: null,
    updatedAt: 1,
    contextTokens: 100,
    contextWindow: 32768,
  };
}
function tab(id = "tab-a", hostId = "42"): Tab {
  return {
    id,
    type: "terminal",
    instanceId: id,
    label: `host-${hostId}`,
    openedAt: 1,
    host: { id: hostId, name: `host-${hostId}` } as Tab["host"],
    terminalRef: {
      current: {
        sendInput: vi.fn(),
        getRecentOutput: vi.fn(() => "should not be read"),
        isConnected: () => true,
        getSessionContext: () => ({
          hostId,
          connected: true,
          sessionId: "human-session",
        }),
      },
    },
  };
}
async function ready() {
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "panelAgent.send" }),
    ).toHaveProperty("disabled", false),
  );
}
async function send(value = "inspect the server") {
  await ready();
  fireEvent.change(screen.getByPlaceholderText("panelAgent.chatPlaceholder"), {
    target: { value },
  });
  fireEvent.click(screen.getByRole("button", { name: "panelAgent.send" }));
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  snapshot = {
    run: makeRun(),
    thread: {
      id: "thread-12345678",
      title: "task",
      lastSeq: 2,
      summary: "",
      summarySeq: 0,
      updatedAt: 1,
    },
    messages: [],
    hasMore: false,
    nextAfter: 2,
  };
  model.getPanelAgentSettings.mockResolvedValue({
    enabled: true,
    provider: "openai-compatible",
    baseUrl: "https://model.invalid/v1",
    model: "test-model",
    temperature: 0,
    maxTokens: 1800,
    toolRoundLimit: 20,
    multiServerEnabled: true,
    maxTargets: 4,
    skills: [],
    apiKeyConfigured: true,
  });
  model.getPanelAgentModels.mockResolvedValue([{ id: "test-model" }]);
  api.active.mockResolvedValue({ run: null });
  api.snapshot.mockImplementation(async () => snapshot);
  api.start.mockImplementation(async (body: StartRuntimeInput) => {
    snapshot.run = { ...makeRun(), id: body.requestId, targets: body.targets };
    snapshot.messages = [
      { ...body.message, seq: 1 },
      {
        id: "response-123",
        seq: 2,
        role: "assistant",
        content: "Backend completed",
      },
    ];
    return { run: snapshot.run };
  });
  api.list.mockResolvedValue({ threads: [], nextOffset: null });
  api.cancel.mockImplementation(async () => ({
    run: { ...snapshot.run!, status: "cancelled" },
  }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
describe("runtime-backed existing Agent view", () => {
  it("creates valid runtime IDs when randomUUID is unavailable", () => {
    let seed = 0;
    const id = createRuntimeClientId({
      getRandomValues: ((array: Uint8Array) => {
        for (let index = 0; index < array.length; index += 1) {
          array[index] = (seed++ * 17 + 3) & 0xff;
        }
        return array;
      }) as Crypto["getRandomValues"],
    } as Pick<Crypto, "randomUUID" | "getRandomValues">);

    expect(id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  });

  it("creates backend-safe user message IDs when randomUUID is unavailable", () => {
    let seed = 0;
    const id = createMessageId({
      getRandomValues: ((array: Uint8Array) => {
        for (let index = 0; index < array.length; index += 1) {
          array[index] = (seed++ * 29 + 7) & 0xff;
        }
        return array;
      }) as Crypto["getRandomValues"],
    } as Pick<Crypto, "randomUUID" | "getRandomValues">);

    expect(id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(id).toMatch(/^[a-zA-Z0-9_-]{8,128}$/);
  });

  it("sends only a user task to the backend, never types commands or reads the human terminal", async () => {
    const terminal = tab();
    render(
      <RuntimePanelAgent terminalTabs={[terminal]} activeTabId={terminal.id} />,
    );
    await send();
    await screen.findByText("Backend completed");
    expect(api.start).toHaveBeenCalledOnce();
    expect(api.start.mock.calls[0][0]).toMatchObject({
      message: { role: "user", content: "inspect the server" },
      targets: [
        {
          targetId: "tab-a",
          hostId: 42,
          terminalSessionId: "human-session",
        },
      ],
      options: { sshMode: "mirror" },
    });
    expect(model.sendPanelAgentChat).not.toHaveBeenCalled();
    expect(terminal.terminalRef!.current!.sendInput).not.toHaveBeenCalled();
    expect(
      terminal.terminalRef!.current!.getRecentOutput,
    ).not.toHaveBeenCalled();
    expect(localStorage.getItem("panelAgentLiveConversation")).toBeNull();
    expect(localStorage.getItem("panelAgentConversationHistory")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Agent 任务选项" }),
    ).toHaveLength(1);
    expect(screen.queryByText("对话存储管理")).toBeNull();
    expect(screen.queryByText("新对话归属")).toBeNull();
  });
  it("detaches on unmount and recovers the same running task without starting or cancelling it", async () => {
    snapshot.run = makeRun("running");
    snapshot.messages = [
      { id: "saved-message", seq: 1, role: "user", content: "ongoing task" },
    ];
    api.active.mockResolvedValue({ run: snapshot.run });
    const view = render(<RuntimePanelAgent terminalTabs={[]} activeTabId="" />);
    await screen.findByText("ongoing task");
    view.unmount();
    expect(api.cancel).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    render(<RuntimePanelAgent terminalTabs={[]} activeTabId="" />);
    await screen.findByText("ongoing task");
    expect(api.snapshot).toHaveBeenCalledWith("thread-12345678");
    expect(api.start).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });
  it("consumes a new-chat action once even though resetting remounts the inner panel", async () => {
    const action = { id: 9001, type: "new" as const };
    render(
      <RuntimePanelAgent
        terminalTabs={[]}
        activeTabId=""
        conversationAction={action}
      />,
    );

    await ready();

    expect(api.active).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "panelAgent.send" }),
    ).toBeTruthy();
  });

  it("reuses the exact request ID and user message after a lost acknowledgement", async () => {
    const startImpl = api.start.getMockImplementation()!;
    api.start
      .mockRejectedValueOnce(new Error("acknowledgement lost"))
      .mockImplementation(startImpl);
    render(<RuntimePanelAgent terminalTabs={[]} activeTabId="" />);
    await send("one task only");
    await screen.findByRole("button", { name: "重试确认请求" });
    const first = api.start.mock.calls[0][0];
    fireEvent.click(screen.getByRole("button", { name: "重试确认请求" }));
    await screen.findByText("Backend completed");
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.start.mock.calls[1][0]).toEqual(first);
    expect(sessionStorage.getItem("cloudssh.panelRuntime.pending")).toBeNull();
  });
  it("deletes legacy browser conversations from localStorage", async () => {
    localStorage.setItem(
      "panelAgentConversationHistory",
      JSON.stringify([
        {
          id: "legacy-a",
          title: "缓存对话",
          messages: [{ role: "user", content: "旧缓存内容" }],
        },
      ]),
    );

    render(
      <RuntimePanelAgent
        terminalTabs={[]}
        activeTabId=""
        conversationAction={{ id: 7001, type: "history" }}
      />,
    );

    expect(await screen.findByText("缓存对话")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(localStorage.getItem("panelAgentConversationHistory")).toBeNull(),
    );
    expect(screen.queryByText("缓存对话")).toBeNull();
  });

  it("does not automatically select another server when restoring a historical run", async () => {
    snapshot.run = {
      ...makeRun(),
      targets: [{ targetId: "old-tab-b", hostId: 99, hostName: "B" }],
    };
    snapshot.messages = [
      {
        id: "saved-message",
        seq: 1,
        role: "user",
        content: "server B history",
      },
    ];
    sessionStorage.setItem("cloudssh.panelRuntime.thread", snapshot.thread.id);
    render(
      <RuntimePanelAgent
        terminalTabs={[tab("tab-a", "42")]}
        activeTabId="tab-a"
      />,
    );
    await screen.findByText("server B history");
    await send("continue");
    await screen.findByText("Backend completed");
    expect(api.start.mock.calls[0][0].targets).toEqual([]);
    expect(api.start.mock.calls[0][0].threadId).toBe(snapshot.thread.id);
  });
  it("does not let browser storage quota failures crash a new task", async () => {
    const native = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(
      function (key, value) {
        if (
          key.startsWith("cloudssh.panelRuntime") ||
          key.startsWith("panelAgentConversation")
        )
          throw new DOMException("full", "QuotaExceededError");
        return native.call(this, key, value);
      },
    );
    render(<RuntimePanelAgent terminalTabs={[]} activeTabId="" />);
    await send();
    await screen.findByText("Backend completed");
    expect(api.start).toHaveBeenCalledOnce();
  });
  it("requires an explicit approval choice and never turns approval into terminal input", async () => {
    const terminal = tab();
    snapshot.run = {
      ...makeRun("waiting_approval"),
      targets: [{ targetId: terminal.id, hostId: 42, hostName: "test" }],
      pending: [
        {
          id: "approval-123",
          name: "run_command",
          arguments: { targetId: terminal.id, command: "touch requested-file" },
        },
      ],
    };
    api.active.mockResolvedValue({ run: snapshot.run });
    api.approve.mockResolvedValue({ accepted: true });
    render(
      <RuntimePanelAgent terminalTabs={[terminal]} activeTabId={terminal.id} />,
    );
    await screen.findByRole("button", { name: "允许执行" });
    expect(api.approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() =>
      expect(api.approve).toHaveBeenCalledWith(
        "run-12345678",
        "approval-123",
        false,
      ),
    );
    expect(terminal.terminalRef!.current!.sendInput).not.toHaveBeenCalled();
  });
  it("keeps large tool details folded and loads raw logs only on demand", async () => {
    api.output.mockResolvedValue({
      jobId: "job-123456",
      status: "completed",
      exitCode: 0,
      stdout: "full log page",
      stderr: "",
      nextStdoutOffset: 13,
      nextStderrOffset: 0,
      stdoutBytes: 13,
      stderrBytes: 0,
      hasMore: false,
    });
    render(
      <RuntimeToolCard
        message={{
          role: "tool",
          name: "run_command",
          content: JSON.stringify({
            jobId: "job-123456",
            command: "pwd",
            status: "completed",
            exitCode: 0,
            stdout: "preview evidence",
          }),
        }}
      />,
    );
    expect(screen.queryByText("preview evidence")).toBeNull();
    expect(api.output).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("preview evidence")).toBeTruthy();
    expect(api.output).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "读取日志末尾" }));
    await screen.findByText("full log page");
    expect(api.output).toHaveBeenCalledOnce();
  });
});
