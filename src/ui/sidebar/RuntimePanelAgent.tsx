import { useCallback, useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/dropdown-menu";
import { runtimeApi } from "@/api/panel-runtime-api";
import type { PanelAgentTargetInput } from "@/api/panel-agent-api";
import type { Tab } from "@/types/ui-types";
import {
  runtimeIsActive,
  type RuntimeMessage,
  type RuntimeOptions,
  type RuntimeRun,
  type RuntimeSnapshot,
  type RuntimeThread,
  type StartRuntimeInput,
} from "@/types/panel-runtime";
import {
  PanelAgentPanel,
  type PanelAgentConversationAction,
} from "./PanelAgentPanel";
import type {
  PanelRuntimeBridge,
  RuntimeUiMessage,
} from "./PanelRuntimeBridge";
const POINTER = "cloudssh.panelRuntime.thread";
const PENDING = "cloudssh.panelRuntime.pending";
function readPointer(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function pointer(key: string, value: string | null) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    /* Metadata only; never fail the chat. */
  }
}
export function createRuntimeClientId(
  cryptoApi:
    | Pick<Crypto, "randomUUID" | "getRandomValues">
    | undefined = globalThis.crypto,
) {
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  }

  return [
    Date.now().toString(36),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
  ].join("-");
}

function legacyChats(): {
  id: string;
  title: string;
  messages: RuntimeUiMessage[];
}[] {
  try {
    const history = JSON.parse(
      localStorage.getItem("panelAgentConversationHistory") || "[]",
    );
    const live = JSON.parse(
      localStorage.getItem("panelAgentLiveConversation") || "null",
    );
    const rows: unknown[] = [
      ...(live?.messages?.length
        ? [
            {
              id: "legacy-live",
              title: "旧浏览器当前对话",
              messages: live.messages,
            },
          ]
        : []),
      ...(Array.isArray(history) ? history : []),
    ];
    return rows.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const v = item as {
        id?: string;
        title?: string;
        messages?: RuntimeUiMessage[];
      };
      if (!Array.isArray(v.messages)) return [];
      return [
        {
          id: String(v.id || "legacy"),
          title: String(v.title || "旧浏览器对话"),
          messages: v.messages
            .filter(
              (message) =>
                message &&
                ["user", "assistant", "tool"].includes(message.role) &&
                typeof message.content === "string",
            )
            .map((message) => ({ ...message, id: createRuntimeClientId() })),
        },
      ];
    });
  } catch {
    return [];
  }
}
export function RuntimePanelAgent(props: {
  terminalTabs: Tab[];
  activeTabId: string;
  embedded?: boolean;
  compact?: boolean;
  conversationAction?: PanelAgentConversationAction | null;
}) {
  const [messages, setMessages] = useState<RuntimeUiMessage[]>([]);
  const [thread, setThread] = useState<RuntimeThread | null>(null);
  const [run, setRun] = useState<RuntimeRun | null>(null);
  const [observedThread, setObservedThread] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState("");
  const [viewKey, setViewKey] = useState(0);
  const [initialTargets, setInitialTargets] = useState<string[]>(() =>
    props.activeTabId ? [props.activeTabId] : [],
  );
  const [records, setRecords] = useState<Omit<RuntimeThread, "summary">[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [legacy, setLegacy] = useState<ReturnType<typeof legacyChats>>([]);
  const [action, setAction] = useState<PanelAgentConversationAction | null>(
    null,
  );
  const mounted = useRef(false);
  const epoch = useRef(0);
  const changing = useRef(false);
  const cursor = useRef(0);
  const threadRef = useRef<RuntimeThread | null>(null);
  const runRef = useRef<RuntimeRun | null>(null);
  const pending = useRef<
    (StartRuntimeInput & { confirmLegacyImport?: boolean }) | null
  >(null);
  const legacySelection = useRef<RuntimeUiMessage[] | null>(null);
  const tabsRef = useRef(props.terminalTabs);
  tabsRef.current = props.terminalTabs;
  useEffect(() => {
    setAction(props.conversationAction ?? null);
  }, [props.conversationAction]);

  const consumeAction = useCallback((id: number) => {
    setAction((current) => (current?.id === id ? null : current));
  }, []);
  const install = useCallback((snapshot: RuntimeSnapshot, replace = false) => {
    if (!mounted.current) return;
    if (
      !replace &&
      threadRef.current?.id === snapshot.thread.id &&
      threadRef.current.lastSeq > snapshot.thread.lastSeq
    )
      return;
    threadRef.current = snapshot.thread;
    setThread(snapshot.thread);
    if (
      !runRef.current ||
      !snapshot.run ||
      snapshot.run.id !== runRef.current.id ||
      snapshot.run.updatedAt >= runRef.current.updatedAt
    ) {
      runRef.current = snapshot.run;
      setRun(snapshot.run);
    }
    cursor.current = snapshot.nextAfter;
    setObservedThread(snapshot.thread.id);
    pointer(POINTER, snapshot.thread.id);
    if (replace) setMessages(snapshot.messages);
    else if (snapshot.messages.length)
      setMessages((old) => {
        const ids = new Set(old.map((message) => message.id));
        return [
          ...old,
          ...snapshot.messages.filter((message) => !ids.has(message.id)),
        ].sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
      });
  }, []);
  const open = useCallback(
    async (id: string, remount = true) => {
      const generation = ++epoch.current;
      const snapshot = await runtimeApi.snapshot(id);
      if (!mounted.current || generation !== epoch.current) return;
      legacySelection.current = null;
      install(snapshot, true);
      if (remount) {
        setInitialTargets(
          tabsRef.current
            .filter((tab) =>
              snapshot.run?.targets.some(
                (target) => target.hostId === Number(tab.host?.id),
              ),
            )
            .map((tab) => tab.id),
        );
        setViewKey((key) => key + 1);
      }
    },
    [install],
  );
  useEffect(() => {
    mounted.current = true;
    const generation = ++epoch.current;
    void (async () => {
      try {
        let id = readPointer(POINTER);
        const uncertain = readPointer(PENDING);
        if (uncertain) {
          try {
            const result = await runtimeApi.run(uncertain);
            id = result.run.threadId;
            pointer(PENDING, null);
          } catch (failure) {
            if ((failure as { status?: number }).status !== 404) throw failure;
            pointer(PENDING, null);
          }
        }
        if (!id) id = (await runtimeApi.active()).run?.threadId ?? null;
        if (!mounted.current || epoch.current !== generation) return;
        if (id) await open(id);
      } catch (failure) {
        if (!mounted.current) return;
        if ((failure as { status?: number }).status === 404)
          pointer(POINTER, null);
        else
          setError(
            failure instanceof Error ? failure.message : "无法恢复后台任务",
          );
      } finally {
        if (mounted.current) setInitialized(true);
      }
    })();
    return () => {
      mounted.current = false;
      epoch.current += 1; /* Detach only. Never cancel backend work on unmount. */
    };
  }, [open]);
  const active = Boolean(run && runtimeIsActive(run.status));
  useEffect(() => {
    if (!observedThread || !active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      const generation = epoch.current;
      let wait = 1200;
      try {
        const value = await runtimeApi.snapshot(observedThread, cursor.current);
        if (!stopped && generation === epoch.current) {
          install(value);
          failures = 0;
          if (!pending.current) setError("");
          if (value.hasMore) wait = 30;
        }
      } catch (failure) {
        if (!stopped && generation === epoch.current)
          setError(
            failure instanceof Error
              ? failure.message
              : "连接中断，后台任务不会因此取消",
          );
        wait = Math.min(8000, 1200 * 2 ** ++failures);
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), wait);
      }
    };
    timer = setTimeout(() => void poll(), 200);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [observedThread, active, install]);
  async function interact(operation: () => Promise<void>) {
    if (changing.current) return;
    changing.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : "操作失败");
    } finally {
      changing.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const refreshHistory = useCallback(async (offset = 0) => {
    try {
      const result = await runtimeApi.list(offset);
      if (mounted.current) {
        setRecords((old) =>
          offset ? [...old, ...result.threads] : result.threads,
        );
        setNextOffset(result.nextOffset);
        setLegacy(legacyChats());
      }
    } catch (failure) {
      if (mounted.current) {
        setLegacy(legacyChats());
        setError(failure instanceof Error ? failure.message : "历史暂不可用");
      }
    }
  }, []);
  async function submit(
    body: StartRuntimeInput & { confirmLegacyImport?: boolean },
  ) {
    pending.current = body;
    pointer(PENDING, body.requestId);
    try {
      const response = await runtimeApi.start(body);
      pending.current = null;
      pointer(PENDING, null);
      pointer(POINTER, response.run.threadId);
      if (!mounted.current) return;
      runRef.current = response.run;
      setRun(response.run);
      setObservedThread(response.run.threadId);
      await open(response.run.threadId, false);
    } catch (failure) {
      const status = (failure as { status?: number }).status;
      if (status && status >= 400 && status < 500) {
        pending.current = null;
        pointer(PENDING, null);
      }
      if (mounted.current)
        setMessages((old) =>
          old.map((message) =>
            message.id === body.message.id
              ? {
                  ...message,
                  error:
                    failure instanceof Error ? failure.message : "请求尚未确认",
                }
              : message,
          ),
        );
      throw failure;
    }
  }
  async function start(
    message: RuntimeUiMessage,
    targets: PanelAgentTargetInput[],
    options: RuntimeOptions,
  ) {
    await interact(async () => {
      if (pending.current) {
        if (pending.current.message.id !== message.id)
          throw new Error("上一条请求尚未确认，请先点重试，避免重复执行");
        await submit(pending.current);
        return;
      }
      const history = legacySelection.current;
      if (
        history &&
        !window.confirm(
          "将这些旧浏览器记录保存到当前账号并用于本次任务？旧浏览器数据不会被删除。",
        )
      )
        return;
      const body: StartRuntimeInput & { confirmLegacyImport?: boolean } = {
        requestId: createRuntimeClientId(),
        threadId: threadRef.current?.id,
        expectedSeq: threadRef.current?.lastSeq,
        message: {
          id: message.id,
          role: "user",
          content: message.content,
          attachments: message.attachments,
        },
        targets: targets.map((target) => ({
          targetId: target.targetId,
          hostId: Number(target.hostId),
          hostName: target.hostName,
          ...(target.sessionId
            ? { terminalSessionId: target.sessionId }
            : {}),
        })),
        options,
        ...(history
          ? { history: history as RuntimeMessage[], confirmLegacyImport: true }
          : {}),
      };
      await submit(body);
    });
  }
  function reset() {
    epoch.current += 1;
    pointer(POINTER, null);
    threadRef.current = null;
    runRef.current = null;
    cursor.current = 0;
    legacySelection.current = null;
    setThread(null);
    setRun(null);
    setObservedThread(null);
    setMessages([]);
    setError("");
    setInitialTargets(props.activeTabId ? [props.activeTabId] : []);
    setViewKey((key) => key + 1);
  }
  function newChat() {
    if (changing.current || pending.current) {
      setError("请先确认尚未完成的请求，再新建对话");
      return;
    }
    if (
      active &&
      !window.confirm(
        "当前任务仍在后台运行。新建对话不会取消它，可通过历史重新打开。继续？",
      )
    )
      return;
    reset();
  }
  function stop() {
    void interact(async () => {
      let current = runRef.current;
      if (pending.current) {
        current = (await runtimeApi.run(pending.current.requestId)).run;
        pending.current = null;
        pointer(PENDING, null);
      }
      if (!current) return;
      const result = await runtimeApi.cancel(current.id);
      runRef.current = result.run;
      setRun(result.run);
      await open(current.threadId, false);
    });
  }
  function resume() {
    void interact(async () => {
      if (!runRef.current) return;
      const result = await runtimeApi.resume(runRef.current.id);
      runRef.current = result.run;
      setRun(result.run);
      await open(result.run.threadId, false);
    });
  }
  function clear() {
    void interact(async () => {
      if (pending.current) throw new Error("请求结果尚未确认，请先重试或停止");
      if (
        !window.confirm(
          "删除当前聊天记录？正在运行的任务会先停止，已执行的服务器操作不会撤销。",
        )
      )
        return;
      if (runRef.current && runtimeIsActive(runRef.current.status))
        await runtimeApi.cancel(runRef.current.id);
      if (threadRef.current) await runtimeApi.remove(threadRef.current.id);
      reset();
      await refreshHistory();
    });
  }
  const status = (
    <div
      className="space-y-1 text-[11px] text-muted-foreground"
      aria-live="polite"
    >
      {run?.status === "compacting" && <p>正在整理上下文，原始记录保留…</p>}
      {run?.status === "waiting_approval" && run.pending[0] && (
        <div className="space-y-2 rounded-xl border border-amber-500/30 p-2">
          <p>
            确认后在独立 SSH 任务执行；重启系统、网络或 CloudSSH
            本身仍可能断开你的连接。
          </p>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all">
            {String(run.pending[0].arguments.command || "")}
          </pre>
          <p>
            目标：
            {
              run.targets.find(
                (target) =>
                  target.targetId === run.pending[0].arguments.targetId,
              )?.hostName
            }{" "}
            · 工作目录：{String(run.pending[0].arguments.cwd || "登录目录")}
          </p>
          <Button
            size="xs"
            disabled={busy}
            onClick={() =>
              void interact(async () => {
                await runtimeApi.approve(run.id, run.pending[0].id, true);
              })
            }
          >
            允许执行
          </Button>{" "}
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void interact(async () => {
                await runtimeApi.approve(run.id, run.pending[0].id, false);
              })
            }
          >
            拒绝
          </Button>
        </div>
      )}
      {(error || run?.error) && (
        <p role="alert" className="break-words text-amber-600">
          {error || run?.error}
        </p>
      )}
      {pending.current && error && (
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void interact(async () => {
              if (pending.current) await submit(pending.current);
            })
          }
        >
          重试确认请求
        </Button>
      )}
      {run && ["paused", "interrupted", "failed"].includes(run.status) && (
        <Button size="xs" variant="ghost" disabled={busy} onClick={resume}>
          检查后继续任务
        </Button>
      )}
    </div>
  );
  const toolbar = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-full"
          aria-label="Agent 任务选项"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-72 rounded-xl">
        <DropdownMenuLabel>Agent 后端任务</DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => setAction({ id: Date.now(), type: "history" })}
        >
          聊天历史
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => setAction({ id: Date.now(), type: "settings" })}
        >
          服务器与技能
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            void interact(async () => {
              const id = threadRef.current?.id;
              if (id) await open(id, false);
              else {
                const result = await runtimeApi.active();
                if (result.run) await open(result.run.threadId);
              }
            })
          }
        >
          刷新任务状态
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="whitespace-normal text-[11px] font-normal">
          上下文自动整理；没有固定工具轮数上限。
          {run?.contextWindow
            ? ` 本次预算 ${run.contextWindow} tokens，估算/最近实际输入 ${run.contextTokens}。`
            : ""}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const history = (
    <div data-testid="panel-agent-history" className="space-y-2 text-xs">
      <p className="font-semibold">聊天历史</p>
      {records.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-1 rounded-xl border border-border/50 p-2"
        >
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left"
            onClick={() =>
              void interact(async () => {
                if (pending.current) throw new Error("请先确认当前请求");
                await open(item.id);
              })
            }
          >
            {item.title}
          </button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void interact(async () => {
                if (!window.confirm("删除这条聊天？")) return;
                await runtimeApi.remove(item.id);
                if (threadRef.current?.id === item.id) reset();
                await refreshHistory();
              })
            }
          >
            删除
          </Button>
        </div>
      ))}
      {nextOffset !== null && (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void refreshHistory(nextOffset)}
        >
          更多历史
        </Button>
      )}
      {!records.length && <p className="text-muted-foreground">暂无后端记录</p>}
      {messages[0]?.seq && messages[0].seq > 1 && thread && (
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void interact(async () => {
              const first = messages[0].seq!;
              const page = await runtimeApi.snapshot(
                thread.id,
                Math.max(0, first - 101),
              );
              setMessages((old) => {
                const ids = new Set(old.map((message) => message.id));
                return [
                  ...page.messages.filter((message) => !ids.has(message.id)),
                  ...old,
                ];
              });
            })
          }
        >
          加载当前对话更早消息
        </Button>
      )}
      {legacy.length > 0 && (
        <p className="pt-2 text-muted-foreground">
          旧浏览器记录（选择后可继续，发送前确认导入）
        </p>
      )}
      {legacy.map((item) => (
        <button
          type="button"
          key={item.id}
          className="block w-full truncate rounded-lg p-2 text-left hover:bg-muted"
          onClick={() => {
            if (changing.current || pending.current) return;
            reset();
            legacySelection.current = item.messages;
            setMessages(item.messages);
            setInitialTargets([]);
            toast.info("已打开旧记录；没有执行命令，也没有删除浏览器备份");
          }}
        >
          {item.title}
        </button>
      ))}
    </div>
  );
  const bridge: PanelRuntimeBridge = {
    messages,
    setMessages,
    working: busy || !initialized || active,
    blocked: Boolean(pending.current),
    initialTargetIds: initialTargets,
    start,
    stop,
    retry: (message) => {
      if (
        message.seq &&
        message.seq === runRef.current?.userSeq &&
        runRef.current &&
        ["paused", "interrupted", "failed"].includes(runRef.current.status)
      )
        resume();
      else if (pending.current)
        void interact(async () => {
          if (pending.current) await submit(pending.current);
        });
      else setError("请选择目标后重新发送任务；不会自动重放历史命令");
    },
    newChat,
    clear,
    refreshHistory: () => void refreshHistory(),
    history,
    toolbar,
    status,
  };
  return (
    <PanelAgentPanel
      key={viewKey}
      {...props}
      conversationAction={action}
      onConversationActionHandled={consumeAction}
      runtimeBridge={bridge}
    />
  );
}
