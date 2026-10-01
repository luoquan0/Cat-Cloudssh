import express, { type RequestHandler } from "express";
import type { Server } from "node:http";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { ConversationError } from "../repositories/panel-conversation-repository.js";
const state = vi.hoisted(() => ({
  authorize: vi.fn(),
  context: vi.fn(),
  append: vi.fn(),
}));
vi.mock("./panel-conversations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./panel-conversations.js")>()),
  authorizeConversation: state.authorize,
  currentConversationRepository: () => ({
    context: state.context,
    append: state.append,
  }),
}));
import { createPanelAgentRouter } from "./panel-agent.js";

let server: Server;
let url: string;
let fetchModel: ReturnType<typeof vi.fn>;
const auth: RequestHandler = (req, _res, next) => {
  Object.assign(req, { userId: "alice", user: { id: "alice" } });
  next();
};
const record = { id: "chat", hostId: 42, revision: 1, messageCount: 1 };
const body = () => ({
  conversationId: "chat",
  conversationRevision: 1,
  messages: [{ role: "user", content: "client-forged-history" }],
  targets: [
    {
      targetId: "ssh42",
      hostId: 42,
      hostName: "test",
      connected: true,
      recentOutput: "",
    },
  ],
});
beforeEach(async () => {
  state.authorize.mockReset().mockResolvedValue(record);
  state.context.mockReset().mockReturnValue({
    messages: [
      { id: "user", role: "user", content: "stored original user request" },
    ],
    omittedMessages: 0,
  });
  state.append
    .mockReset()
    .mockResolvedValue({ ...record, revision: 2, messageCount: 2 });
  fetchModel = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "checking server",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "read_terminal_context",
                      arguments: JSON.stringify({
                        targetId: "ssh42",
                        maxLines: 50,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const settings = new Map([
    ["panel_agent_api_key", "test-key-not-for-client"],
    [
      "panel_agent_settings_v1",
      JSON.stringify({
        enabled: true,
        baseUrl: "https://api.example.test/v1",
        model: "test-model",
        temperature: 0.2,
        maxTokens: 1000,
      }),
    ],
  ]);
  const app = express();
  app.use(express.json());
  app.use(
    "/panel-agent",
    createPanelAgentRouter({
      authenticate: auth,
      requireAdmin: auth,
      settings: {
        get: async (key) => settings.get(key) ?? null,
        set: async (key, value) => {
          settings.set(key, value);
        },
        delete: async (key) => {
          settings.delete(key);
        },
      },
      fetchImpl: fetchModel as unknown as typeof fetch,
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  url = `http://127.0.0.1:${address.port}/panel-agent/chat`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const send = (input = body()) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

describe("durable model chat boundary", () => {
  it("uses authorized server history and waits for the reply to be saved before returning tools", async () => {
    let saved = false;
    state.append.mockImplementation(async () => {
      await Promise.resolve();
      saved = true;
      return { ...record, revision: 2, messageCount: 2 };
    });
    const response = await send();
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(saved).toBe(true);
    expect(result.message.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.message.toolCalls).toHaveLength(1);
    expect(state.append).toHaveBeenCalledWith(
      "alice",
      "chat",
      1,
      [
        expect.objectContaining({
          id: result.message.id,
          role: "assistant",
          toolCalls: expect.any(Array),
        }),
      ],
      "test-model",
    );
    const payload = JSON.parse(fetchModel.mock.calls[0][1].body);
    expect(JSON.stringify(payload)).toContain("stored original user request");
    expect(JSON.stringify(payload)).not.toContain("client-forged-history");
    expect(JSON.stringify(result)).not.toContain("test-key-not-for-client");
    expect(state.authorize).toHaveBeenCalledTimes(2);
  });
  it("never returns executable tool calls when durable storage rejected the reply", async () => {
    state.append.mockRejectedValue(
      new ConversationError("storage quota full", 413, "CONVERSATION_QUOTA"),
    );
    const response = await send();
    const result = await response.json();
    expect(response.status).toBe(413);
    expect(result).not.toHaveProperty("message");
    expect(result.code).toBe("CONVERSATION_QUOTA");
  });
  it("refuses stale revisions and incomplete history before making a paid model request", async () => {
    expect((await send({ ...body(), conversationRevision: 0 })).status).toBe(
      409,
    );
    expect(fetchModel).not.toHaveBeenCalled();
    state.context.mockReturnValue({ messages: [], omittedMessages: 20 });
    expect((await send()).status).toBe(409);
    expect(fetchModel).not.toHaveBeenCalled();
    expect(state.append).not.toHaveBeenCalled();
  });
  it("rechecks server permissions after the model call", async () => {
    state.authorize
      .mockResolvedValueOnce(record)
      .mockRejectedValueOnce(new ConversationError("revoked", 403));
    const response = await send();
    expect(response.status).toBe(403);
    expect(state.append).not.toHaveBeenCalled();
    expect(await response.json()).not.toHaveProperty("message");
  });
});
