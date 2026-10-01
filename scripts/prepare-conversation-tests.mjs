import fs from "node:fs";
await import("./apply-agent-conversations.mjs");
const path = "src/ui/tests/sidebar/PanelAgentPanel.test.tsx";
let source = fs.readFileSync(path, "utf8");
function replace(from, to) {
  if (!source.includes(from)) throw new Error(`Test integration anchor missing: ${from.slice(0, 80)}`);
  source = source.replace(from, to);
}
function testBlock(name, nextName, text) {
  const start = source.indexOf(`  it("${name}"`);
  const end = source.indexOf(`  it("${nextName}"`, start + 1);
  if (start < 0 || end < 0) throw new Error(`Test integration block missing: ${name}`);
  source = source.slice(0, start) + text + source.slice(end);
}
replace('vi.mock("@/api/panel-agent-api", () => panelAgentApi);', `vi.mock("@/api/panel-agent-api", () => panelAgentApi);
vi.mock("@/api/panel-conversations-api", async () => {
  const { makeConversationApiFixture } = await import("./conversation-api-fixture");
  return { conversationApi: makeConversationApiFixture(), downloadConversation: vi.fn() };
});
`);
replace('import { PanelAgentPanel } from "@/sidebar/PanelAgentPanel";', `import { PanelAgentPanel } from "@/sidebar/PanelAgentPanel";
import { conversationApi } from "@/api/panel-conversations-api";
import { conversationRows, resetConversationRows } from "./conversation-api-fixture";`);
replace("    localStorage.clear();", `    localStorage.clear();
    sessionStorage.clear();
    resetConversationRows();
    vi.spyOn(window, "confirm").mockReturnValue(true);`);
replace(`    await waitFor(() =>
      expect(localStorage.getItem("panelAgentLiveConversation")).toContain(
        "old question",
      ),
    );`, `    await waitFor(() => expect(JSON.stringify([...conversationRows.values()])).toContain("old question"));`);
replace(`    expect(screen.queryByText("old question")).toBeNull();
    expect(screen.queryByText("old answer")).toBeNull();`, `    await waitFor(() => {
      expect(screen.queryByText("old question")).toBeNull();
      expect(screen.queryByText("old answer")).toBeNull();
    });
    expect(conversationRows.size).toBe(0);`);
testBlock("restores the active chat from localStorage after remounting", "exposes desktop cockpit actions for history and new chats", `  it("restores the active chat from the server after remounting", async () => {
    const saved = await conversationApi.create("saved", "saved chat", []);
    await conversationApi.append(saved.id, saved.revision, [
      { id: "user", role: "user", content: "hidden sidebar context" },
      { id: "answer", role: "assistant", content: "still preserved", toolCalls: [] },
    ], []);
    const first = render(<PanelAgentPanel terminalTabs={[]} activeTabId="" />);
    await screen.findByText("hidden sidebar context");
    expect(screen.getByText("still preserved")).toBeTruthy();
    expect(localStorage.getItem("panelAgentLiveConversation")).toBeNull();
    first.unmount();
    render(<PanelAgentPanel terminalTabs={[]} activeTabId="" />);
    await screen.findByText("hidden sidebar context");
    expect(screen.getByText("still preserved")).toBeTruthy();
  });

`);
testBlock("compacts legacy live chat snapshots instead of persisting image data URLs", "restores the selected model from localStorage", `  it("imports legacy image snapshots only after explicit ownership confirmation without deleting originals", async () => {
    const hugeDataUrl = "data:image/png;base64," + "a".repeat(400_000);
    const legacy = JSON.stringify({ updatedAt: 1, messages: [{ role: "user", content: "keep this message", attachments: [{ id: "image-1", name: "large.png", mimeType: "image/png", size: 300_000, kind: "image", dataUrl: hugeDataUrl }] }] });
    localStorage.setItem("panelAgentLiveConversation", legacy);
    render(<PanelAgentPanel terminalTabs={[]} activeTabId="" />);
    await screen.findByPlaceholderText("panelAgent.chatPlaceholder");
    expect(screen.queryByText("keep this message")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "panelAgent.history" }));
    const button = await screen.findByText("确认归属并导入旧记录");
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    await screen.findByText("已导入（原浏览器记录仍保留）");
    expect([...conversationRows.values()][0].messages[0].attachments?.[0].dataUrl).toBe(hugeDataUrl);
    expect(localStorage.getItem("panelAgentLiveConversation")).toBe(legacy);
  });

`);
// This existing context-limit regression now seeds the durable archive, not an unowned legacy cache.
const oversizedStart = source.indexOf('  it("bounds oversized historical context');
if (oversizedStart >= 0) {
  const next = source.indexOf('\n  it(', oversizedStart + 8);
  let block = source.slice(oversizedStart, next);
  const pattern = /    localStorage\.setItem\(\s*"panelAgentLiveConversation",\s*JSON\.stringify\(\{ messages: storedMessages \}\),\s*\);/;
  if (!pattern.test(block)) throw new Error("Oversized history seed anchor missing");
  block = block.replace(pattern, `    const saved = await conversationApi.create("large", "large transcript", []);
    await conversationApi.append(saved.id, saved.revision, storedMessages.map((message, i) => ({ ...message, role: message.role as "user" | "assistant", id: "stored-" + i })), []);`);
  source = source.slice(0, oversizedStart) + block + source.slice(next);
}
fs.writeFileSync(path, source);
// Do not leak database sequence numbers or model metadata into legacy /chat message payloads.
const panelPath = "src/ui/sidebar/PanelAgentPanel.tsx";
let panel = fs.readFileSync(panelPath, "utf8");
panel = panel.replace('messages.map(({ id: _id, error: _error, ...message }) => message)', 'messages.map(({ id: _id, error: _error, seq: _seq, createdAt: _createdAt, model: _model, ...message }) => message)');
fs.writeFileSync(panelPath, panel);
const fixturePath = "src/ui/tests/sidebar/conversation-api-fixture.ts";
let fixture = fs.readFileSync(fixturePath, "utf8");
fixture = fixture.replace('childId: string) => {', 'childId: string): Promise<ConversationInfo> => {')
  .replace('messages: ConversationMessage[]) => {', 'messages: ConversationMessage[]): Promise<ConversationInfo> => {');
fs.writeFileSync(fixturePath, fixture);
console.log("Updated existing chat regressions to use the durable server fixture");
