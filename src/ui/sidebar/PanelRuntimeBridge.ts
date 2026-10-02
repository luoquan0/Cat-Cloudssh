import type { Dispatch, ReactNode, SetStateAction } from "react";
import type {
  PanelAgentChatMessage,
  PanelAgentTargetInput,
} from "@/api/panel-agent-api";
import type { RuntimeOptions } from "@/types/panel-runtime";
export type RuntimeUiMessage = PanelAgentChatMessage & {
  id: string;
  seq?: number;
  error?: string;
};
export type PanelRuntimeBridge = {
  messages: RuntimeUiMessage[];
  setMessages: Dispatch<SetStateAction<RuntimeUiMessage[]>>;
  working: boolean;
  blocked?: boolean;
  initialTargetIds: string[];
  start: (
    message: RuntimeUiMessage,
    targets: PanelAgentTargetInput[],
    options: RuntimeOptions,
  ) => Promise<void>;
  stop: () => void;
  retry: (message: RuntimeUiMessage) => void;
  newChat: () => void;
  clear: () => void;
  refreshHistory: () => void;
  history: ReactNode;
  toolbar: ReactNode;
  status: ReactNode;
};
