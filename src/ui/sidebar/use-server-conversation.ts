import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { conversationApi } from "@/api/panel-conversations-api";
import type { ConversationHost, ConversationInfo, ConversationMessage, ConversationPage } from "@/types/panel-conversation";

export type ArchivedUiMessage = ConversationMessage & { error?: string };
export const newConversationId = () => globalThis.crypto?.randomUUID?.() ?? `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : "服务器对话同步失败";

export function useServerConversation(setMessages: Dispatch<SetStateAction<ArchivedUiMessage[]>>) {
  const [record, setRecord] = useState<ConversationInfo | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [before, setBefore] = useState<number | null>(null);
  const current = useRef<ConversationInfo | null>(null);
  const knownIds = useRef(new Set<string>());
  const owner = useRef("");
  const epoch = useRef(0);
  const mounted = useRef(false);
  const creationId = useRef(newConversationId());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const jobs = useRef(0);

  const pointer = useCallback((value: string) => {
    if (!owner.current) return;
    try { sessionStorage.setItem(`panelAgentActiveConversation:${owner.current}`, value); } catch { /* Non-essential, tiny metadata only. */ }
  }, []);
  const publish = useCallback((value: ConversationInfo | null) => {
    current.current = value;
    if (mounted.current) setRecord(value);
  }, []);
  const install = useCallback((page: ConversationPage) => {
    publish(page.conversation);
    knownIds.current = new Set(page.messages.map((message) => message.id));
    setMessages(page.messages);
    setBefore(page.before);
    pointer(page.conversation.id);
  }, [pointer, publish, setMessages]);

  const initialize = useCallback(async () => {
    const generation = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      const list = await conversationApi.list({ limit: 1 });
      if (!mounted.current || generation !== epoch.current) return;
      owner.current = list.userId;
      let id: string | null = null;
      try { id = sessionStorage.getItem(`panelAgentActiveConversation:${list.userId}`); } catch { /* Storage may be disabled. */ }
      // A new device can resume the most recent server transcript via the same account.
      if (!id) id = list.items[0]?.id ?? null;
      if (id && id !== "new") {
        try {
          const page = await conversationApi.page(id);
          if (!mounted.current || generation !== epoch.current) return;
          install(page);
        } catch (cause) {
          if (![403, 404].includes((cause as { status?: number }).status ?? 0)) throw cause;
          pointer("new");
        }
      }
      if (mounted.current && generation === epoch.current) setInitialized(true);
    } catch (cause) {
      if (mounted.current && generation === epoch.current) setError(errorText(cause));
    } finally {
      if (mounted.current && generation === epoch.current) setBusy(false);
    }
  }, [install, pointer]);

  useEffect(() => {
    mounted.current = true;
    void initialize();
    return () => { mounted.current = false; epoch.current += 1; };
  }, [initialize]);

  const manage = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    jobs.current += 1;
    if (mounted.current) { setBusy(true); setError(""); }
    try { return await task(); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); throw cause; }
    finally { jobs.current -= 1; if (mounted.current && jobs.current === 0) setBusy(false); }
  }, []);

  const reset = useCallback(() => {
    epoch.current += 1;
    creationId.current = newConversationId();
    knownIds.current.clear();
    publish(null);
    setMessages([]);
    setBefore(null);
    setError("");
    pointer("new");
  }, [pointer, publish, setMessages]);

  const open = useCallback(async (id: string) => {
    const generation = ++epoch.current;
    await manage(async () => {
      const page = await conversationApi.page(id);
      if (mounted.current && generation === epoch.current) install(page);
    });
  }, [install, manage]);

  const save = useCallback((messages: ArchivedUiMessage[], hosts: ConversationHost[]) => {
    const generation = epoch.current;
    // Snapshot the inputs now; later renders must not move a pending write to another conversation.
    const snapshot = messages.map(({ error: _error, seq: _seq, createdAt: _createdAt, ...message }) => message);
    const task = queue.current.catch(() => undefined).then(() => manage(async () => {
      if (generation !== epoch.current) throw new Error("对话已切换，已停止旧任务");
      let active = current.current;
      if (!active) {
        const title = (snapshot.find((message) => message.role === "user")?.content || "新对话").trim().slice(0, 120) || "新对话";
        active = await conversationApi.create(creationId.current, title, hosts);
        if (generation !== epoch.current) throw new Error("对话已切换，旧记录已保存在服务器");
        publish(active);
        pointer(active.id);
      }
      const pending = snapshot.filter((message) => !knownIds.current.has(message.id));
      // Even an empty append may bind a newly selected server. Writes are always serialized.
      const batches = pending.length ? Array.from({ length: Math.ceil(pending.length / 100) }, (_, i) => pending.slice(i * 100, (i + 1) * 100)) : [[]];
      for (const batch of batches) {
        active = await conversationApi.append(active.id, active.revision, batch, hosts);
        if (generation !== epoch.current) throw new Error("对话已切换，旧记录已保存在服务器");
        for (const message of batch) knownIds.current.add(message.id);
        publish(active);
      }
      return active;
    }));
    queue.current = task;
    return task;
  }, [manage, pointer, publish]);

  const accept = useCallback((response: { conversation?: ConversationInfo; message: { id?: string } }) => {
    if (response.conversation && response.conversation.id === current.current?.id) {
      publish(response.conversation);
      if (response.message.id) knownIds.current.add(response.message.id);
    }
  }, [publish]);

  const loadOlder = useCallback(async () => {
    const active = current.current;
    if (!active || before === null) return;
    const generation = epoch.current;
    await manage(async () => {
      const page = await conversationApi.page(active.id, before);
      if (generation !== epoch.current || !mounted.current) return;
      for (const message of page.messages) knownIds.current.add(message.id);
      setMessages((messages) => [...page.messages.filter((item) => !messages.some((message) => message.id === item.id)), ...messages]);
      setBefore(page.before);
      // Never adopt a newer revision from a partial read: it could hide concurrent appends.
    });
  }, [before, manage, setMessages]);

  const compact = useCallback(async (model?: string) => {
    const active = current.current;
    if (!active) return;
    const generation = epoch.current;
    return manage(async () => {
      const result = await conversationApi.compact(active.id, active.revision, model);
      if (generation === epoch.current && mounted.current) publish(result);
      return result;
    });
  }, [manage, publish]);

  const update = useCallback(async (patch: { title?: string; autoCompact?: boolean }) => {
    const active = current.current;
    if (!active) return;
    await manage(async () => publish(await conversationApi.update(active.id, active.revision, patch)));
  }, [manage, publish]);

  const remove = useCallback(async () => {
    const active = current.current;
    if (active) await manage(() => conversationApi.delete(active.id, active.revision));
    reset();
  }, [manage, reset]);

  const fork = useCallback(async (messageId: string) => {
    const active = current.current;
    if (!active) throw new Error("请先保存对话后重试");
    return manage(async () => {
      const child = await conversationApi.fork(active.id, messageId, newConversationId());
      const page = await conversationApi.page(child.id);
      epoch.current += 1;
      install(page);
      return page.messages;
    });
  }, [install, manage]);

  return { record, initialized, busy, error, before, initialize, open, save, accept, reset, remove, fork, compact, update, loadOlder };
}
