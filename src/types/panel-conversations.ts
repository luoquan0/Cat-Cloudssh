export interface StoredChatMessage {
  recordedAt?: string;
  model?: string;
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: {
    id: string;
    name: "run_terminal_command" | "read_terminal_context";
    arguments: Record<string, unknown>;
  }[];
  attachments?: {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    kind: "image" | "text" | "file";
    dataUrl?: string;
    text?: string;
  }[];
}

export interface PanelConversation {
  id: string;
  hostId: number | null;
  title: string;
  model: string;
  revision: number;
  messageCount: number;
  sizeBytes: number;
  summary: string;
  summaryThrough: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationPage {
  messages: StoredChatMessage[];
  nextBefore: number | null;
}

export interface ConversationContext {
  messages: StoredChatMessage[];
  needsCompaction: boolean;
  omittedMessages: number;
  summaryThrough: number;
}
