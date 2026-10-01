import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { PanelAgentPanel as ChatPanel } from "./PanelAgentPanel";
import type { PanelConversationBridge } from "./PanelConversationBridge";
import {
  conversationApi,
  ConversationWriter,
} from "@/api/panel-conversations-api";
import type {
  PanelConversation,
  StoredChatMessage,
} from "@/types/panel-conversations";
export type { PanelAgentConversationAction } from "./PanelAgentPanel";

function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "聊天记录操作失败";
}

export function PanelAgentPanel(
  props: Omit<ComponentProps<typeof ChatPanel>, "persistence">,
) {
  const activeHost = Number(
    props.terminalTabs.find((t) => t.id === props.activeTabId)?.host?.id,
  );
  const [scope, setScope] = useState<number | null>(
    Number.isSafeInteger(activeHost) && activeHost > 0 ? activeHost : null,
  );
  const [record, setRecord] = useState<PanelConversation | null>(null);
  const [initial, setInitial] = useState<StoredChatMessage[]>([]);
  const [generation, setGeneration] = useState(0);
  const [records, setRecords] = useState<PanelConversation[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [allHosts, setAllHosts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const [ready, setReady] = useState(false);
  const [autoCompact, setAutoCompact] = useState(true);
  const [status, setStatus] = useState("正在加载服务器记录…");
  const [error, setError] = useState("");
  const [summaryOpen, setSummaryOpen] = useState(false);
  const writer = useRef<ConversationWriter | null>(null);
  const creating = useRef<Promise<ConversationWriter> | null>(null);
  const pendingId = useRef(newId());
  const selectedModel = useRef("");
  const latest = useRef<StoredChatMessage[]>([]);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const loadEpoch = useRef(0);
  const listEpoch = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadEpoch.current++;
      writer.current?.dispose();
    };
  }, []);
  const notify = useCallback((saved: PanelConversation) => {
    if (!mounted.current || writer.current?.record.id !== saved.id) return;
    setRecord(saved);
    setStatus("已保存到服务器");
    setError("");
    setRecords((items) => [saved, ...items.filter((c) => c.id !== saved.id)]);
  }, []);
  const showError = useCallback((e: unknown) => {
    if (!mounted.current) return;
    setError(errorText(e));
    setStatus("保存未确认，请重试或导出本地副本");
  }, []);

  const refresh = useCallback(
    async (offset = 0) => {
      const epoch = ++listEpoch.current;
      const page = await conversationApi.list(
        allHosts ? "all" : scope,
        search,
        offset,
      );
      if (!mounted.current || epoch !== listEpoch.current) return;
      setRecords((old) =>
        offset ? [...old, ...page.conversations] : page.conversations,
      );
      setNextOffset(page.nextOffset);
    },
    [scope, search, allHosts],
  );

  const install = useCallback(
    (
      saved: PanelConversation | null,
      messages: StoredChatMessage[],
      nextBefore: number | null,
      preserveComposer = false,
    ) => {
      writer.current?.dispose();
      writer.current = saved
        ? new ConversationWriter(saved, messages, notify)
        : null;
      creating.current = null;
      pendingId.current = newId();
      latest.current = messages;
      setRecord(saved);
      setInitial(messages);
      setBefore(nextBefore);
      if (!preserveComposer) setGeneration((n) => n + 1);
      setReady(true);
      setError("");
      setStatus(saved ? "已加载服务器记录" : "新消息将保存到服务器");
    },
    [notify],
  );

  useEffect(() => {
    const epoch = ++loadEpoch.current;
    setReady(false);
    void conversationApi
      .list(scope)
      .then(async (page) => {
        const first = page.conversations[0];
        const messages = first ? await conversationApi.page(first.id) : null;
        if (!mounted.current || epoch !== loadEpoch.current) return;
        setRecords(page.conversations);
        setNextOffset(page.nextOffset);
        install(
          first ?? null,
          messages?.messages ?? [],
          messages?.nextBefore ?? null,
        );
      })
      .catch(showError);
    return () => {
      loadEpoch.current++;
    };
  }, [scope, install, showError]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch(showError);
    }, 250);
    return () => {
      window.clearTimeout(timer);
      listEpoch.current++;
    };
  }, [refresh, showError]);

  async function ensureWriter(
    messages: StoredChatMessage[],
  ): Promise<ConversationWriter> {
    if (writer.current) return writer.current;
    if (!creating.current) {
      const id = pendingId.current;
      const title =
        messages
          .find((m) => m.role === "user")
          ?.content.trim()
          .slice(0, 100) || "新对话";
      creating.current = conversationApi
        .create(scope, title, id)
        .then((saved) => {
          const value = new ConversationWriter(saved, [], notify);
          writer.current = value;
          notify(saved);
          return value;
        })
        .finally(() => {
          creating.current = null;
        });
    }
    return creating.current;
  }
  async function flush(
    messages = latest.current,
    model?: string,
  ): Promise<void> {
    latest.current = messages;
    if (!messages.length && !writer.current) return;
    try {
      setStatus("正在保存…");
      const value = await ensureWriter(messages);
      await value.flush(messages, model ?? value.model);
      if (mounted.current && writer.current === value) {
        setStatus("已保存到服务器");
        setError("");
      }
    } catch (e) {
      showError(e);
      throw e;
    }
  }
  // Durable saves are explicitly awaited at every user/model/tool boundary by
  // ChatPanel. This callback updates the unsaved export snapshot, not render state.
  function observe(messages: StoredChatMessage[]): void {
    latest.current = messages;
    writer.current?.observe(messages);
  }
  async function run(operation: () => Promise<void>): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await operation();
    } catch (e) {
      showError(e);
      toast.error(errorText(e));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function openConversation(saved: PanelConversation): Promise<void> {
    try {
      await flush();
    } catch (error) {
      if (
        !window.confirm(
          "当前页面有未确认保存的消息。请先导出本地副本；仍要放弃未保存内容并重新打开服务器记录吗？",
        )
      )
        throw error;
      await settleWrites();
    }
    const current = await conversationApi.get(saved.id);
    const page = await conversationApi.page(saved.id);
    // Scope switching effect would otherwise reopen the newest conversation.
    // The record itself remains the authoritative server association.
    install(current, page.messages, page.nextBefore);
  }
  async function compact(model?: string): Promise<boolean> {
    await flush();
    const value = writer.current;
    if (!value) return false;
    setStatus("正在生成摘要（原始消息不会删除）…");
    const result = await conversationApi.compact(
      value.record.id,
      value.record.revision,
      model || selectedModel.current || value.model || undefined,
    );
    value.update(result.conversation);
    return result.compacted;
  }
  async function prepare(
    messages: StoredChatMessage[],
    model: string,
    signal: AbortSignal,
  ) {
    await flush(messages, model);
    signal.throwIfAborted();
    const value = writer.current!;
    let context = await conversationApi.context(value.record.id);
    if (autoCompact && context.needsCompaction) {
      for (let pass = 0; pass < 4; pass++) {
        signal.throwIfAborted();
        const result = await conversationApi.compact(
          value.record.id,
          value.record.revision,
          model || undefined,
        );
        value.update(result.conversation);
        context = await conversationApi.context(value.record.id);
        if (!result.compacted || !context.omittedMessages) break;
        await new Promise((resolve) => window.setTimeout(resolve, 3100));
      }
    }
    signal.throwIfAborted();
    if (context.omittedMessages) {
      throw new Error(
        "未压缩历史已超过模型上下文预算。请点击“压缩”继续生成摘要，或新建对话；原始记录仍保留在服务器。",
      );
    }
    return {
      messages: context.messages,
      conversationId: value.record.id,
      conversationRevision: value.record.revision,
    };
  }

  function newConversation(): void {
    void run(async () => {
      await flush();
      install(null, [], null);
    });
  }
  async function settleWrites(): Promise<void> {
    await creating.current?.catch(() => undefined);
    await writer.current?.settled();
  }
  function deleteCurrent(): void {
    if (
      !window.confirm(
        "删除当前聊天记录？此操作不会关闭 SSH，也不会撤销已经执行的命令。删除后不能在历史中恢复。",
      )
    )
      return;
    void run(async () => {
      await settleWrites();
      try {
        await conversationApi.remove(
          writer.current?.record.id ?? pendingId.current,
        );
      } catch (error) {
        // A lost create acknowledgement may leave a known server ID, or
        // no row at all. Explicit deletion is idempotent in both cases.
        if ((error as { status?: number }).status !== 404) throw error;
      }
      install(null, [], null);
      await refresh();
    });
  }
  function exportLocal(): void {
    download(
      new Blob(
        [
          JSON.stringify(
            {
              schemaVersion: 1,
              conversation: record,
              messages: latest.current,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
      "cloudssh-local-conversation.json",
    );
  }
  async function importLegacy(): Promise<void> {
    if (
      !window.confirm(
        "将此浏览器的旧聊天导入当前登录账号的通用对话？请确认这些记录属于你。原浏览器记录不会删除。",
      )
    )
      return;
    const history = JSON.parse(
      localStorage.getItem("panelAgentConversationHistory") || "[]",
    );
    const live = JSON.parse(
      localStorage.getItem("panelAgentLiveConversation") || "null",
    );
    const entries = Array.isArray(history) ? [...history] : [];
    if (Array.isArray(live?.messages) && live.messages.length)
      entries.push({
        ...live,
        id: `live-${live.updatedAt ?? 0}`,
        title: "浏览器当前对话",
      });
    let imported = 0;
    for (const [index, entry] of entries.entries()) {
      if (!entry || !Array.isArray(entry.messages) || !entry.messages.length)
        continue;
      const sourceId = String(
        entry.id ?? `archive-${entry.updatedAt ?? 0}-${index}`,
      )
        .replace(/[^A-Za-z0-9_.:-]/g, "_")
        .slice(0, 100);
      const saved = await conversationApi.create(
        null,
        String(entry.title || "浏览器旧对话").slice(0, 160),
        `legacy-${sourceId}`,
      );
      const messages = entry.messages.map(
        (m: StoredChatMessage, i: number) => ({
          ...m,
          id: `legacy-message-${i}`,
        }),
      );
      // Reimport is idempotent: deterministic IDs and immutable saved messages.
      let current = saved;
      for (let i = 0; i < messages.length; i += 100)
        current = await conversationApi.append(
          saved.id,
          current.revision,
          messages.slice(i, i + 100),
          "",
        );
      imported++;
    }
    await refresh();
    toast.success(`已导入 ${imported} 个对话到“通用对话”；原浏览器记录已保留`);
  }

  const disabled = busy || working || !ready;
  const hosts = new Map<number, string>();
  props.terminalTabs.forEach((tab) => {
    const id = Number(tab.host?.id);
    if (id > 0) hosts.set(id, tab.host?.name || `服务器 #${id}`);
  });
  if (scope && !hosts.has(scope)) hosts.set(scope, `服务器 #${scope}`);
  const label =
    record?.hostId != null
      ? hosts.get(record.hostId) || `服务器 #${record.hostId}`
      : record
        ? "通用对话"
        : scope
          ? hosts.get(scope)
          : "通用对话";

  const history = (
    <section className="space-y-2" aria-label="服务器聊天历史">
      <div className="flex items-center justify-between">
        <strong>服务器聊天历史</strong>
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={() => void run(() => refresh())}
        >
          刷新
        </Button>
      </div>
      <input
        className="w-full rounded-lg border bg-background p-2 text-xs"
        aria-label="搜索对话标题"
        placeholder="搜索对话标题"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <label className="flex gap-2 text-xs">
        <input
          type="checkbox"
          checked={allHosts}
          onChange={(e) => setAllHosts(e.target.checked)}
        />
        显示所有服务器的对话（仅当前账号）
      </label>
      {records.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-1 rounded-lg border p-2 text-xs"
        >
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            disabled={disabled}
            onClick={() => void run(() => openConversation(item))}
          >
            <span className="block truncate">{item.title}</span>
            <span className="text-muted-foreground">
              {item.hostId ? `服务器 #${item.hostId}` : "通用"} ·{" "}
              {item.messageCount} 条 ·{" "}
              {new Date(item.updatedAt).toLocaleString()}
            </span>
          </button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              void run(async () => {
                const title = window.prompt("修改对话标题", item.title);
                if (!title?.trim()) return;
                await flush();
                const fresh = await conversationApi.get(item.id);
                const saved = await conversationApi.rename(
                  item.id,
                  fresh.revision,
                  title,
                );
                if (writer.current?.record.id === item.id)
                  writer.current.update(saved);
                await refresh();
              })
            }
          >
            改名
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              if (!window.confirm(`永久删除“${item.title}”？`)) return;
              void run(async () => {
                // Deletion must remain possible when a new save hit quota.
                await settleWrites();
                await conversationApi.remove(item.id);
                if (writer.current?.record.id === item.id)
                  install(null, [], null);
                await refresh();
              });
            }}
          >
            删除
          </Button>
        </div>
      ))}
      {!records.length && (
        <p className="text-xs text-muted-foreground">没有匹配的服务器记录</p>
      )}
      {nextOffset !== null && (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void run(() => refresh(nextOffset))}
        >
          加载更多对话
        </Button>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => void run(importLegacy)}
        >
          导入浏览器旧记录
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            if (
              !window.confirm(
                `清空${scope ? `服务器 #${scope}` : "通用对话"}下当前账号的全部聊天？不会删除其他服务器的记录。`,
              )
            )
              return;
            void run(async () => {
              await settleWrites();
              await conversationApi.removeScope(scope);
              if ((writer.current?.record.hostId ?? scope) === scope)
                install(null, [], null);
              await refresh();
            });
          }}
        >
          清空本分类历史
        </Button>
      </div>
    </section>
  );

  const toolbar = (
    <section
      className="shrink-0 space-y-1 rounded-xl border p-2 text-xs"
      aria-label="对话存储管理"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label>
          新对话归属{" "}
          <select
            aria-label="聊天归属服务器"
            className="max-w-40 rounded border bg-background"
            value={scope ?? "general"}
            disabled={busy || working}
            onChange={(e) => {
              const target =
                e.target.value === "general" ? null : Number(e.target.value);
              void run(async () => {
                await flush();
                setScope(target);
              });
            }}
          >
            <option value="general">通用对话</option>
            {[...hosts].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <span>当前：{label}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || !record}
          onClick={() =>
            void run(async () => {
              if (
                !window.confirm(
                  "使用已配置的模型生成历史摘要（会产生模型调用费用）？原始消息不会删除。",
                )
              )
                return;
              const changed = await compact();
              setSummaryOpen(true);
              toast.success(
                changed
                  ? "摘要已保存，原始记录完整保留"
                  : "暂无可压缩的较早完整轮次",
              );
            })
          }
        >
          压缩
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!record}
          onClick={() => setSummaryOpen((v) => !v)}
        >
          查看摘要
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || !record}
          onClick={() =>
            void run(async () => {
              await settleWrites();
              download(
                await conversationApi.export(writer.current!.record.id),
                `cloudssh-${record!.id}.json`,
              );
            })
          }
        >
          导出完整记录
        </Button>
        <Button size="xs" variant="ghost" onClick={exportLocal}>
          导出本地副本
        </Button>
        {before !== null && (
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              void run(async () => {
                await flush();
                const value = writer.current!;
                const page = await conversationApi.page(
                  value.record.id,
                  before,
                );
                install(
                  value.record,
                  [...page.messages, ...latest.current],
                  page.nextBefore,
                  true,
                );
              })
            }
          >
            加载更早消息
          </Button>
        )}
      </div>
      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={autoCompact}
          disabled={busy || working}
          onChange={(e) => setAutoCompact(e.target.checked)}
        />
        自动摘要（使用当前模型，会产生调用费用）
      </label>
      <p role="status" className="text-muted-foreground">
        {status}
        {record
          ? ` · ${record.messageCount} 条 · 摘要覆盖前 ${record.summaryThrough} 条`
          : ""}
      </p>
      {error && (
        <div role="alert" className="text-destructive">
          {error}
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || working}
            onClick={() =>
              void run(async () => {
                if (!ready) {
                  const page = await conversationApi.list(scope);
                  if (page.conversations[0])
                    await openConversation(page.conversations[0]);
                  else install(null, [], null);
                } else await flush();
              })
            }
          >
            重试
          </Button>
        </div>
      )}
      {summaryOpen && (
        <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded border p-2">
          {record?.summary || "还没有摘要；较早对话压缩后会显示在这里。"}
        </div>
      )}
    </section>
  );
  const persistence: PanelConversationBridge = {
    hostId: record ? record.hostId : scope,
    onModel: (model) => {
      selectedModel.current = model;
    },
    initialMessages: initial,
    onMessages: observe,
    onWorking: setWorking,
    flush,
    prepare,
    onNew: newConversation,
    onClear: deleteCurrent,
    history,
    toolbar,
    disabled: busy || !ready,
  };
  return <ChatPanel {...props} key={generation} persistence={persistence} />;
}
