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
  source = replace(source, '        if (!archive.record) {\n          await startConversation', '        if (!archive.record || !archive.isSaved(message.id)) {\n          await startConversation');
  source = replace(source, '        const seed = await archive.fork(message.id);', '        if (!window.confirm("重试会创建独立对话，可能再次执行模型建议的命令。原记录和已执行的服务器操作不会撤销，请先核实终端状态。继续？")) return;\n        const seed = await archive.fork(message.id);');
  return source;
});
edit("src/ui/sidebar/use-server-conversation.ts", (source) => replace(source, 'compact, update, loadOlder, windowMessages };', 'compact, update, loadOlder, windowMessages, isSaved: (id: string) => knownIds.current.has(id) };'));
edit("src/ui/sidebar/ServerConversationHistory.tsx", (source) => source.replace("export function readLegacyConversations()", "function readLegacyConversations()"));
edit("src/ui/tests/sidebar/PanelAgentPanel.test.tsx", (source) => {
  source = replace(source, 'expect(screen.getByText("desktop ops")).toBeTruthy();', 'expect(await screen.findByText("desktop ops")).toBeTruthy();');
  const marker = '  it("sends the full live chat history to the backend"';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("Missing full context regression");
  let tail = source.slice(start);
  tail = replace(tail, `    localStorage.setItem(
      "panelAgentLiveConversation",
      JSON.stringify({ messages: storedMessages }),
    );`, `    const saved = await conversationApi.create("full-history", "full transcript", []);
    await conversationApi.append(saved.id, saved.revision, storedMessages.map((message, i) => ({
      ...message, role: message.role as "user" | "assistant", id: "full-stored-" + i,
    })), []);`);
  tail = replace(tail, '    await screen.findByPlaceholderText("panelAgent.chatPlaceholder");', '    await screen.findByPlaceholderText("panelAgent.chatPlaceholder");\n    await screen.findByText("stored-0");');
  return source.slice(0, start) + tail;
});
// Assert the persisted chat timeout separately; existing stateless APIs retain their current budgets.
fs.appendFileSync("src/ui/tests/api/panel-agent-api.test.ts", String.raw`
it("allows the bounded summary and model phases for a persisted conversation", async () => {
  api.post.mockResolvedValue({ data: { message: { id: "model-reply", role: "assistant", content: "saved", toolCalls: [] } } });
  const controller = new AbortController();
  await sendPanelAgentChat({ conversationId: "conversation", revision: 1, requestId: "request", messages: [{ role: "user", content: "continue" }], targets: [] }, controller.signal);
  expect(api.post).toHaveBeenLastCalledWith("/panel-agent/chat", expect.objectContaining({ conversationId: "conversation", revision: 1, requestId: "request" }), expect.objectContaining({ timeout: 285_000, signal: controller.signal }));
});
`);
fs.appendFileSync("src/ui/tests/sidebar/use-server-conversation.test.tsx", String.raw`
it("distinguishes a failed message append from a saved message so retry does not fork a nonexistent boundary", async () => {
  const { result } = mount();
  await waitFor(() => expect(result.current.initialized).toBe(true));
  const messages: ArchivedUiMessage[] = [{ id: "not-saved", role: "user", content: "retry me" }];
  vi.mocked(conversationApi.append).mockRejectedValueOnce(new Error("offline"));
  await act(async () => { await expect(result.current.save(messages, [])).rejects.toThrow("offline"); });
  expect(result.current.record).not.toBeNull();
  expect(result.current.isSaved("not-saved")).toBe(false);
  await act(async () => { await result.current.save(messages, []); });
  expect(result.current.isSaved("not-saved")).toBe(true);
});
`);
console.log("Final conversation integration safeguards applied");
