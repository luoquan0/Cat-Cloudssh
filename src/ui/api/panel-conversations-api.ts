import { authApi } from "@/main-axios";
import type {
  PanelConversation,
  StoredChatMessage,
  ConversationPage,
  ConversationContext,
} from "@/types/panel-conversations";

const prefix = "/panel-agent/conversations";
async function request<T>(
  method: "get" | "post" | "patch" | "delete",
  path: string,
  data?: unknown,
): Promise<T> {
  try {
    const response = await authApi.request<T>({
      method,
      url: prefix + path,
      data,
      timeout: 180_000,
    });
    return response.data;
  } catch (error) {
    const e = error as {
      response?: { status?: number; data?: { error?: string; code?: string } };
      message?: string;
    };
    throw Object.assign(
      new Error(e.response?.data?.error || e.message || "聊天记录请求失败"),
      {
        status: e.response?.status,
        code: e.response?.data?.code,
      },
    );
  }
}
export const conversationApi = {
  list: (hostId: number | null | "all", search = "", offset = 0) =>
    request<{ conversations: PanelConversation[]; nextOffset: number | null }>(
      "get",
      `?hostId=${hostId ?? "general"}&search=${encodeURIComponent(search)}&offset=${offset}`,
    ),
  create: (hostId: number | null, title: string, id: string) =>
    request<PanelConversation>("post", "", { hostId, title, id }),
  get: (id: string) =>
    request<PanelConversation>("get", `/${encodeURIComponent(id)}`),
  page: (id: string, before?: number) =>
    request<ConversationPage>(
      "get",
      `/${encodeURIComponent(id)}/messages${before ? "?before=" + before : ""}`,
    ),
  append: (
    id: string,
    revision: number,
    messages: StoredChatMessage[],
    model: string,
  ) =>
    request<PanelConversation>("post", `/${encodeURIComponent(id)}/messages`, {
      revision,
      messages,
      model,
    }),
  rename: (id: string, revision: number, title: string) =>
    request<PanelConversation>("patch", `/${encodeURIComponent(id)}`, {
      revision,
      title,
    }),
  remove: (id: string) => request<void>("delete", `/${encodeURIComponent(id)}`),
  removeScope: (hostId: number | null) =>
    request<void>("delete", "", { hostId, confirmation: "DELETE_SCOPE" }),
  context: (id: string) =>
    request<ConversationContext>("get", `/${encodeURIComponent(id)}/context`),
  compact: (id: string, revision: number, model?: string) =>
    request<{ conversation: PanelConversation; compacted: boolean }>(
      "post",
      `/${encodeURIComponent(id)}/compact`,
      { revision, model },
    ),
  export: async (id: string) => {
    const result = await authApi.get(
      `${prefix}/${encodeURIComponent(id)}/export`,
      { responseType: "blob", timeout: 180_000 },
    );
    return result.data as Blob;
  },
};

export function messageSnapshot(message: StoredChatMessage): StoredChatMessage {
  // Exclude UI-only error/retry flags. Original text, tool results and image
  // attachments are retained; no localStorage compaction is applied here.
  const { id, role, content, toolCallId, name, toolCalls, attachments } =
    message;
  return {
    id,
    role,
    content,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  };
}

export class ConversationWriter {
  private chain: Promise<unknown> = Promise.resolve();
  private known = new Set<string>();
  private active = true;
  latest: StoredChatMessage[];
  model = "";
  constructor(
    public record: PanelConversation,
    initial: StoredChatMessage[],
    private notify: (record: PanelConversation) => void,
    private api = conversationApi,
  ) {
    this.model = record.model;
    this.latest = initial;
    initial.forEach((m) => this.known.add(m.id));
  }
  async settled(): Promise<void> {
    await this.chain.catch(() => undefined);
  }
  observe(messages: StoredChatMessage[]): void {
    this.latest = messages;
  }
  dispose(): void {
    this.active = false;
  }
  update(record: PanelConversation): void {
    this.record = record;
    if (this.active) this.notify(record);
  }
  flush(messages = this.latest, model = this.model): Promise<void> {
    this.latest = messages;
    this.model = model;
    const snapshot = messages.map(messageSnapshot);
    const operation = this.chain
      .catch(() => undefined)
      .then(async () => {
        for (let index = 0; index < snapshot.length; index += 100) {
          const batch = snapshot
            .slice(index, index + 100)
            .filter((m) => !this.known.has(m.id));
          if (!batch.length) continue;
          const expectedCount = this.record.messageCount + batch.length;
          const saved = await this.api.append(
            this.record.id,
            this.record.revision,
            batch,
            model,
          );
          if (saved.messageCount > expectedCount) {
            throw new Error(
              "此对话已在其他窗口更新，请导出未保存副本并重新打开，避免覆盖记录",
            );
          }
          batch.forEach((m) => this.known.add(m.id));
          this.update(saved);
        }
      });
    this.chain = operation;
    return operation;
  }
}
