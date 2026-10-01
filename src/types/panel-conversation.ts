/** Personal model transcripts, not a replacement for SSH audit/recording. */
export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: Array<{
    id: string;
    name: "run_terminal_command" | "read_terminal_context";
    arguments: Record<string, unknown>;
  }>;
  attachments?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    kind: "image" | "text" | "file";
    dataUrl?: string;
    text?: string;
  }>;
  model?: string;
  seq?: number;
  createdAt?: string;
}

export interface ConversationHost {
  hostId: number;
  projectHostId?: number;
}

export interface ConversationInfo {
  id: string;
  title: string;
  hosts: ConversationHost[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  messageCount: number;
  sizeBytes: number;
  summary: string;
  summaryThrough: number;
  summaryModel: string | null;
  autoCompact: boolean;
}

export interface ConversationPage {
  conversation: ConversationInfo;
  messages: ConversationMessage[];
  before: number | null;
}

export interface ConversationList {
  userId: string;
  items: ConversationInfo[];
  nextOffset: number | null;
}
