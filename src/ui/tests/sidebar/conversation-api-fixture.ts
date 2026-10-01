import { vi } from "vitest";
import type { ConversationHost, ConversationInfo, ConversationMessage } from "@/types/panel-conversation";

export const conversationRows = new Map<string, { info: ConversationInfo; messages: ConversationMessage[] }>();
export function resetConversationRows() { conversationRows.clear(); }
export function makeConversationApiFixture() {
  const get = (id: string) => {
    const row = conversationRows.get(id);
    if (!row) throw Object.assign(new Error("not found"), { status: 404 });
    return row;
  };
  const api = {
    list: vi.fn(async (options: { hostId?: number; search?: string; limit?: number; offset?: number } = {}) => {
      const items = [...conversationRows.values()].map((row) => row.info).filter((item) =>
        (!options.hostId || item.hosts.some((host) => host.hostId === options.hostId)) && (!options.search || item.title.includes(options.search)));
      return { userId: "test-user", items: items.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 30)), nextOffset: null };
    }),
    create: vi.fn(async (id: string, title: string, hosts: ConversationHost[]) => {
      if (conversationRows.has(id)) return get(id).info;
      const info: ConversationInfo = { id, title, hosts, revision: 0, messageCount: 0, sizeBytes: 0, summary: "", summaryThrough: 0, summaryModel: null, autoCompact: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
      conversationRows.set(id, { info, messages: [] });
      return info;
    }),
    page: vi.fn(async (id: string, before?: number) => {
      const row = get(id);
      const messages = row.messages.filter((item) => before === undefined || item.seq! < before).slice(-100);
      return { conversation: row.info, messages, before: messages.length && messages[0].seq! > 1 ? messages[0].seq! : null };
    }),
    append: vi.fn(async (id: string, revision: number, messages: ConversationMessage[], hosts: ConversationHost[]) => {
      const row = get(id);
      const fresh = messages.filter((item) => !row.messages.some((saved) => saved.id === item.id));
      if (fresh.length && revision !== row.info.revision) throw Object.assign(new Error("conflict"), { status: 409 });
      row.messages = [...row.messages, ...fresh.map((message, i) => ({ ...message, seq: row.messages.length + i + 1 }))];
      row.info = { ...row.info, hosts: [...new Map([...row.info.hosts, ...hosts].map((host) => [host.hostId, host])).values()], revision: row.info.revision + (fresh.length ? 1 : 0), messageCount: row.messages.length, sizeBytes: JSON.stringify(row.messages).length };
      return row.info;
    }),
    update: vi.fn(async (id: string, _revision: number, patch: Partial<ConversationInfo>) => {
      const row = get(id); row.info = { ...row.info, ...patch, revision: row.info.revision + 1 }; return row.info;
    }),
    delete: vi.fn(async (id: string) => { get(id); conversationRows.delete(id); }),
    deleteAll: vi.fn(async (hostId?: number) => {
      let deleted = 0;
      for (const [id, row] of conversationRows) if (!hostId || row.info.hosts.some((host) => host.hostId === hostId)) { conversationRows.delete(id); deleted += 1; }
      return { deleted };
    }),
    compact: vi.fn(async (id: string) => {
      const row = get(id); row.info = { ...row.info, revision: row.info.revision + 1, summary: "factual memory", summaryThrough: 1, summaryModel: "test-model" }; return row.info;
    }),
    fork: vi.fn(async (id: string, messageId: string, childId: string) => {
      const row = get(id);
      const boundary = row.messages.findIndex((item) => item.id === messageId);
      const created = await api.create(childId, row.info.title + " retry", row.info.hosts);
      return api.append(childId, created.revision, row.messages.slice(0, boundary + 1), row.info.hosts);
    }),
    import: vi.fn(async (legacyId: string, title: string, messages: ConversationMessage[]) => {
      const created = await api.create(`import-${legacyId}`, title, []);
      return api.append(created.id, created.revision, messages, []);
    }),
    export: vi.fn(async (id: string) => new Blob([JSON.stringify(get(id))], { type: "application/json" })),
  };
  return api;
}
