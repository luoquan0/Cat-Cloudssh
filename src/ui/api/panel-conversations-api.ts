import axios from "axios";
import { authApi } from "@/main-axios";
import type { ConversationHost, ConversationInfo, ConversationList, ConversationMessage, ConversationPage } from "@/types/panel-conversation";

const prefix = "/panel-agent/conversations";
async function request<T>(task: () => Promise<{ data: T }>): Promise<T> {
  try { return (await task()).data; }
  catch (error) {
    if (axios.isAxiosError(error)) {
      const payload = error.response?.data as { error?: string; code?: string } | undefined;
      throw Object.assign(new Error(payload?.error || "服务器对话同步失败，请检查连接后重试"), { code: payload?.code, status: error.response?.status });
    }
    throw error;
  }
}
const path = (id: string) => `${prefix}/${encodeURIComponent(id)}`;
export const conversationApi = {
  list: (options: { hostId?: number; search?: string; offset?: number; limit?: number } = {}) =>
    request<ConversationList>(() => authApi.get(prefix, { params: options })),
  create: (id: string, title: string, hosts: ConversationHost[]) =>
    request<ConversationInfo>(() => authApi.post(prefix, { id, title, hosts })),
  page: (id: string, before?: number) =>
    request<ConversationPage>(() => authApi.get(path(id), { params: { before } })),
  append: (id: string, revision: number, messages: ConversationMessage[], hosts: ConversationHost[]) =>
    request<ConversationInfo>(() => authApi.post(`${path(id)}/messages`, { revision, messages, hosts }, { timeout: 120_000 })),
  update: (id: string, revision: number, patch: { title?: string; autoCompact?: boolean }) =>
    request<ConversationInfo>(() => authApi.patch(path(id), { ...patch, revision })),
  delete: (id: string, revision: number) =>
    request<void>(() => authApi.delete(path(id), { data: { revision } })),
  deleteAll: (hostId?: number) =>
    request<{ deleted: number }>(() => authApi.delete(prefix, { data: { confirm: "delete-all", hostId } })),
  compact: (id: string, revision: number, model?: string) =>
    request<ConversationInfo>(() => authApi.post(`${path(id)}/compact`, { revision, model }, { timeout: 150_000 })),
  fork: (id: string, messageId: string, newId: string) =>
    request<ConversationInfo>(() => authApi.post(`${path(id)}/fork`, { id: newId, messageId })),
  import: (legacyId: string, title: string, messages: ConversationMessage[]) =>
    request<ConversationInfo>(() => authApi.post(`${prefix}/import`, { legacyId, title, messages, confirmOwnership: true }, { timeout: 120_000 })),
  export: (id: string) => request<Blob>(() => authApi.get(`${path(id)}/export`, { responseType: "blob", timeout: 120_000 })),
};

export function downloadConversation(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
