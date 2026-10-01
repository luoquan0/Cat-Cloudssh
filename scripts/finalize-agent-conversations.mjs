import fs from "node:fs";
function edit(path, transform) { fs.writeFileSync(path, transform(fs.readFileSync(path, "utf8"))); }
function replace(source, from, to) {
  if (!source.includes(from)) throw new Error(`Finalization anchor missing: ${from.slice(0, 80)}`);
  return source.replace(from, to);
}
function removeSection(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`Cleanup boundary missing: ${start}`);
  return source.slice(0, a) + source.slice(b);
}
edit("src/ui/api/panel-agent-api.ts", (source) => {
  source = replace(source, "timeout: 285_000,", "timeout: 180_000,");
  return replace(source, `      ...PANEL_AGENT_REQUEST_CONFIG,
      signal,`, `      ...PANEL_AGENT_REQUEST_CONFIG,
      // A stored conversation may first summarize, then retry once without tools.
      timeout: input.conversationId ? 285_000 : PANEL_AGENT_REQUEST_CONFIG.timeout,
      signal,`);
});
edit("src/ui/sidebar/PanelAgentPanel.tsx", (source) => {
  source = removeSection(source, "const PANEL_AGENT_CONVERSATION_HISTORY_STORAGE_KEY =", "const MAX_CHAT_ATTACHMENTS");
  source = source.replace("const MAX_STORED_MESSAGES_PER_CONVERSATION = 120;\n", "");
  source = removeSection(source, "function compactMessagesForStorage(", "function toBoundedRequestMessages(");
  source = removeSection(source, "function conversationTitle(", "function ");
  source = removeSection(source, "  function abortConversation() {", "  function conversationHosts() {");
  return source;
});
edit("src/ui/sidebar/ServerConversationHistory.tsx", (source) => source.replace("export function readLegacyConversations()", "function readLegacyConversations()"));
// Assert the persisted chat timeout separately; existing stateless APIs retain their current budgets.
fs.appendFileSync("src/ui/tests/api/panel-agent-api.test.ts", String.raw`
it("allows the bounded summary and model phases for a persisted conversation", async () => {
  api.post.mockResolvedValue({ data: { message: { id: "model-reply", role: "assistant", content: "saved", toolCalls: [] } } });
  const controller = new AbortController();
  await sendPanelAgentChat({ conversationId: "conversation", revision: 1, requestId: "request", messages: [{ role: "user", content: "continue" }], targets: [] }, controller.signal);
  expect(api.post).toHaveBeenLastCalledWith("/panel-agent/chat", expect.objectContaining({ conversationId: "conversation", revision: 1, requestId: "request" }), expect.objectContaining({ timeout: 285_000, signal: controller.signal }));
});
`);
console.log("Final conversation integration safeguards applied");
