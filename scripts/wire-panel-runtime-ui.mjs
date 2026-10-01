import fs from "node:fs";
function edit(path, transform) { fs.writeFileSync(path, transform(fs.readFileSync(path, "utf8"))); }
function replace(source, from, to) { if (!source.includes(from)) throw new Error(`UI integration anchor missing: ${from.slice(0, 100)}`); return source.replace(from, to); }
edit("src/ui/sidebar/PanelAgentPanel.tsx", source => {
  source = `import type { PanelRuntimeBridge } from "./PanelRuntimeBridge";
import { RuntimeToolCard } from "./RuntimeToolCard";
` + source;
  source = replace(source, '  conversationAction = null,\n}: {', '  conversationAction = null,\n  runtimeBridge,\n}: {');
  source = replace(source, '  conversationAction?: PanelAgentConversationAction | null;\n}) {', '  conversationAction?: PanelAgentConversationAction | null;\n  runtimeBridge?: PanelRuntimeBridge;\n}) {');
  source = replace(source, '  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(new Set());\n  const [messages, setMessages] = useState<PanelAgentUiMessage[]>(\n    readStoredLiveConversation,\n  );\n  const [working, setWorking] = useState(false);', `  const runtimeMode = Boolean(runtimeBridge);
  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(() => new Set(runtimeBridge?.initialTargetIds ?? []));
  const [localMessages, setLocalMessages] = useState<PanelAgentUiMessage[]>(() => runtimeBridge ? [] : readStoredLiveConversation());
  const messages = runtimeBridge?.messages ?? localMessages;
  const setMessages = runtimeBridge?.setMessages ?? setLocalMessages;
  const [localWorking, setWorking] = useState(false);
  const working = runtimeBridge?.working ?? localWorking;`);
  source = replace(source, '    readStoredConversationHistory,\n', '    () => runtimeBridge ? [] : readStoredConversationHistory(),\n');
  source = replace(source, '    writeStoredLiveConversation(messages);\n  }, [messages]);', '    if (!runtimeMode) writeStoredLiveConversation(messages);\n  }, [messages, runtimeMode]);');
  source = replace(source, '    writeStoredConversationHistory(conversationHistory);\n  }, [conversationHistory]);', '    if (!runtimeMode) writeStoredConversationHistory(conversationHistory);\n  }, [conversationHistory, runtimeMode]);');
  source = replace(source, '    if (activeTerminalTab && selectedTabIds.size === 0)', '    if (!runtimeMode && activeTerminalTab && selectedTabIds.size === 0)');
  source = replace(source, '  }, [activeTerminalTab, selectedTabIds.size]);', '  }, [activeTerminalTab, selectedTabIds.size, runtimeMode]);');
  source = replace(source, '          recentOutput: handle?.getRecentOutput?.(5000) ?? "",', '          recentOutput: runtimeMode ? "" : handle?.getRecentOutput?.(5000) ?? "",');
  source = replace(source, '    userMessageId: string,\n  ) {\n    abortControllerRef.current?.abort();', `    userMessageId: string,
  ) {
    if (runtimeBridge) {
      const message = seedMessages.find(item => item.id === userMessageId);
      if (message) await runtimeBridge.start(message, selectedTargets(), { model: selectedModel.trim() || undefined, reasoningEffort: thinkingMode, skillIds: [...selectedSkillIds] });
      return;
    }
    abortControllerRef.current?.abort();`);
  source = replace(source, '    if (!message || message.role !== "user") return;\n    const nextMessages', '    if (!message || message.role !== "user") return;\n    if (runtimeBridge) { runtimeBridge.retry(message); return; }\n    const nextMessages');
  source = replace(source, '  function stopConversation() {\n    abortControllerRef.current?.abort();', '  function stopConversation() {\n    if (runtimeBridge) { runtimeBridge.stop(); return; }\n    abortControllerRef.current?.abort();');
  source = replace(source, '  function clearConversation() {\n    abortConversation();', '  function clearConversation() {\n    if (runtimeBridge) { runtimeBridge.clear(); return; }\n    abortConversation();');
  source = replace(source, '  function newConversation() {\n    abortConversation();', '  function newConversation() {\n    if (runtimeBridge) { runtimeBridge.newChat(); return; }\n    abortConversation();');
  source = replace(source, '  function toggleHistory() {\n    setSettingsOpen(false);', '  function toggleHistory() {\n    if (runtimeBridge && !historyOpen) runtimeBridge.refreshHistory();\n    setSettingsOpen(false);');
  source = replace(source, '  function renderHistoryPanel() {\n    return (', '  function renderHistoryPanel() {\n    if (runtimeBridge) return runtimeBridge.history;\n    return (');
  source = replace(source, '  function renderToolMessage(message: PanelAgentChatMessage, index: number) {\n    const payload', '  function renderToolMessage(message: PanelAgentChatMessage, index: number) {\n    if (runtimeBridge) return <RuntimeToolCard key={message.toolCallId ?? index} message={message} />;\n    const payload');
  source = replace(source, '  if (toolCall.name === "run_terminal_command") {', '  if (toolCall.name === "run_terminal_command" || toolCall.name === "run_command") {');
  source = replace(source, '            <div ref={latestMessageRef}', '            {runtimeBridge?.status}\n            <div ref={latestMessageRef}');
  source = replace(source, '            {renderThinkingSelector(compact)}', '            {renderThinkingSelector(compact)}\n            {runtimeBridge?.toolbar}');
  source = replace(source, '  const { promise, resolve } = Promise.withResolvers<void>();\n  window.setTimeout(resolve, ms);\n  return promise;', '  return new Promise<void>(resolve => window.setTimeout(resolve, ms));');
  return source;
});
edit("src/ui/api/panel-agent-api.ts", source => replace(source, '  | "read_terminal_context";', '  | "read_terminal_context"\n  | "run_command"\n  | "read_job_output"\n  | "cancel_job";'));
edit("src/ui/workspace/WorkspaceUtilityRail.tsx", source => replace(source, `import {
  PanelAgentPanel,
  type PanelAgentConversationAction,
} from "@/sidebar/PanelAgentPanel";`, `import { RuntimePanelAgent as PanelAgentPanel } from "@/sidebar/RuntimePanelAgent";
import type { PanelAgentConversationAction } from "@/sidebar/PanelAgentPanel";`));
edit("src/ui/tests/workspace/WorkspaceUtilityRail.test.tsx", source => source.replace('vi.mock("@/sidebar/PanelAgentPanel",', 'vi.mock("@/sidebar/RuntimePanelAgent",').replace('  PanelAgentPanel: ({', '  RuntimePanelAgent: ({'));
edit("src/backend/panel-runtime/policy.ts", source => source.split("\n").map(line => line.includes("if (!command ||") ? line.replace('\\[', '[').replace('\\"', '"') : line).join("\n"));
console.log("Existing Agent UI now delegates execution to the backend runtime.");
