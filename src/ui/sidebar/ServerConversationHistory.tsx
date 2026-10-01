import { useEffect, useRef, useState } from "react";
import { conversationApi, downloadConversation } from "@/api/panel-conversations-api";
import type { ConversationInfo, ConversationMessage } from "@/types/panel-conversation";

const legacyKeys = ["panelAgentLiveConversation", "panelAgentConversationHistory"] as const;
export function readLegacyConversations(): Array<{ legacyId: string; title: string; messages: ConversationMessage[] }> {
  const records: Array<{ legacyId: string; title: string; messages: ConversationMessage[] }> = [];
  for (const key of legacyKeys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const values = key === "panelAgentConversationHistory" ? parsed : [parsed];
      if (!Array.isArray(values)) continue;
      for (const [index, item] of values.entries()) {
        if (!item || !Array.isArray(item.messages) || !item.messages.length) continue;
        records.push({
          legacyId: `${key}:${String(item.id ?? item.updatedAt ?? index).slice(0, 120)}`,
          title: String(item.title ?? item.messages.find((message: { role?: string }) => message.role === "user")?.content ?? "导入的旧对话").slice(0, 120) || "导入的旧对话",
          messages: item.messages.map((message: ConversationMessage, i: number) => ({ ...message, id: `legacy-message-${i}` })),
        });
      }
    } catch { /* Leave unreadable originals untouched. */ }
  }
  return records;
}

export function ServerConversationHistory({ hostId, disabled, onOpen, onDeleted, onUpdated, onDeleteAll, onClose }: {
  hostId?: number;
  disabled: boolean;
  onOpen(id: string): Promise<void>;
  onDeleted(id: string): void;
  onUpdated(record: ConversationInfo): void;
  onDeleteAll(hostId?: number): void;
  onClose(): void;
}) {
  const [items, setItems] = useState<ConversationInfo[]>([]);
  const [search, setSearch] = useState("");
  const [currentHostOnly, setCurrentHostOnly] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [imported, setImported] = useState(false);
  const [legacy, setLegacy] = useState(readLegacyConversations);
  const queryEpoch = useRef(0);
  const filterHost = currentHostOnly ? hostId : undefined;

  useEffect(() => {
    const epoch = ++queryEpoch.current;
    setBusy(true);
    const timer = setTimeout(() => {
      conversationApi.list({ hostId: filterHost, search }).then((result) => {
        if (epoch !== queryEpoch.current) return;
        setItems(result.items); setNextOffset(result.nextOffset); setError("");
      }).catch((cause) => { if (epoch === queryEpoch.current) setError(String(cause.message || cause)); })
        .finally(() => { if (epoch === queryEpoch.current) setBusy(false); });
    }, 150);
    return () => { clearTimeout(timer); queryEpoch.current += 1; };
  }, [filterHost, search, refresh]);

  async function perform(task: () => Promise<void>) {
    setBusy(true); setError("");
    try { await task(); setRefresh((n) => n + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusy(false); }
  }
  const blocked = busy || disabled;
  return <section data-testid="panel-agent-history" className="space-y-3 text-xs">
    <div className="flex items-center justify-between gap-2">
      <strong>服务器对话历史</strong>
      <button type="button" onClick={onClose} aria-label="关闭历史记录">关闭</button>
    </div>
    <p className="text-muted-foreground">仅显示当前账号有权访问的记录。原始聊天、工具调用和返回内容保存在 CloudSSH 数据库，不是 SSH 录像。</p>
    <input aria-label="搜索对话" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题或聊天内容" className="w-full rounded-lg border bg-background p-2" />
    {hostId && <label className="flex items-center gap-2"><input type="checkbox" checked={currentHostOnly} onChange={(event) => setCurrentHostOnly(event.target.checked)} />仅当前服务器（#{hostId}）</label>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!busy && !items.length && <p>没有匹配的对话</p>}
    {items.map((item) => <div key={item.id} className="space-y-2 rounded-xl border p-2">
      <button type="button" disabled={blocked} onClick={() => void perform(() => onOpen(item.id))} className="w-full text-left font-medium">{item.title}</button>
      <p className="text-muted-foreground">{new Date(item.updatedAt).toLocaleString()} · {item.messageCount} 条 · {(item.sizeBytes / 1024).toFixed(1)} KB · {item.hosts.length ? item.hosts.map((host) => `#${host.hostId}`).join(" / ") : "未绑定服务器"}</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={blocked} onClick={() => {
          const title = window.prompt("对话新名称（最多 200 字符）", item.title);
          if (title?.trim()) void perform(async () => onUpdated(await conversationApi.update(item.id, item.revision, { title: title.trim() })));
        }}>重命名</button>
        <button type="button" disabled={blocked} onClick={() => void perform(async () => downloadConversation(await conversationApi.export(item.id), `conversation-${item.id}.json`))}>导出原文</button>
        <button type="button" className="text-destructive" disabled={blocked} onClick={() => {
          if (window.confirm(`永久删除“${item.title}”的聊天、附件和摘要？此操作不删除 SSH 审计/录像，也不能撤回已有导出或备份。`)) void perform(async () => {
            await conversationApi.delete(item.id, item.revision); onDeleted(item.id);
          });
        }}>删除</button>
      </div>
    </div>)}
    {nextOffset !== null && <button type="button" disabled={blocked} onClick={() => {
      const epoch = queryEpoch.current;
      setBusy(true);
      conversationApi.list({ hostId: filterHost, search, offset: nextOffset }).then((result) => {
        if (epoch === queryEpoch.current) {
          setItems((previous) => [...previous, ...result.items.filter((item) => !previous.some((other) => other.id === item.id))]);
          setNextOffset(result.nextOffset);
        }
      }).catch((cause) => { if (epoch === queryEpoch.current) setError(String(cause.message || cause)); })
        .finally(() => { if (epoch === queryEpoch.current) setBusy(false); });
    }}>加载更多</button>}
    <button type="button" disabled={blocked || !items.length} className="text-destructive" onClick={() => {
      const scope = filterHost ? `当前服务器 #${filterHost} 的全部对话（含同时关联其他服务器的对话）` : "当前账号的全部对话";
      if (window.confirm(`永久删除${scope}？此操作不受搜索关键词限制，不能撤销。`)) void perform(async () => {
        await conversationApi.deleteAll(filterHost); onDeleteAll(filterHost);
      });
    }}>清空{filterHost ? "当前服务器" : "当前账号"}历史</button>
    {legacy.length > 0 && <div className="space-y-2 rounded-xl border p-2">
      <p>检测到 {legacy.length} 个旧浏览器记录。旧版本没有账号标识，导入前请确认这些记录属于当前账号。已裁剪的旧内容无法恢复。</p>
      <button type="button" disabled={blocked || imported} onClick={() => {
        if (!window.confirm("确认这些旧浏览器对话属于当前登录账号，并将其上传保存到此 CloudSSH 服务器？")) return;
        void perform(async () => {
          for (const item of legacy) await conversationApi.import(item.legacyId, item.title, item.messages);
          setImported(true);
        });
      }}>{imported ? "已导入（原浏览器记录仍保留）" : "确认归属并导入旧记录"}</button>
      {imported && <button type="button" disabled={blocked} onClick={() => {
        if (!window.confirm("已确认全部导入成功。只删除此浏览器的旧聊天缓存，不删除服务器记录？")) return;
        try { for (const key of legacyKeys) localStorage.removeItem(key); setLegacy([]); }
        catch { setError("无法清除旧缓存，服务器记录不受影响"); }
      }}>清理已导入的旧缓存</button>}
    </div>}
    {busy && <p role="status">正在同步服务器记录…</p>}
  </section>;
}
