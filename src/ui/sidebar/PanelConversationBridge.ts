import type { ReactNode } from "react";
import type { StoredChatMessage } from "@/types/panel-conversations";

export interface PanelConversationBridge {
  hostId: number | null;
  onModel: (model: string) => void;
  initialMessages: StoredChatMessage[];
  onMessages: (messages: StoredChatMessage[]) => void;
  onWorking: (working: boolean) => void;
  flush: (messages: StoredChatMessage[], model?: string) => Promise<void>;
  prepare: (
    messages: StoredChatMessage[],
    model: string,
    signal: AbortSignal,
  ) => Promise<{
    messages: StoredChatMessage[];
    conversationId: string;
    conversationRevision: number;
  }>;
  onNew: () => void;
  onClear: () => void;
  history: ReactNode;
  toolbar: ReactNode;
  disabled: boolean;
}
