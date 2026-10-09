import { describe, expect, it, vi } from "vitest";
import type { RuntimeRun } from "../../types/panel-runtime.js";
import {
  basePrompt,
  ContextOverflowError,
  OpenAIRuntimeModel,
  type RuntimeModelConfig,
} from "./model.js";
const config: RuntimeModelConfig = {
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://model.invalid/v1/chat/completions",
  model: "compatible-model",
  temperature: 0.2,
  maxTokens: 1500,
  contextWindowTokens: 32768,
  multiServerEnabled: true,
  maxTargets: 4,
  skills: [],
};
const run: RuntimeRun = {
  id: "run-12345678",
  threadId: "thread-12345678",
  status: "running",
  userSeq: 1,
  targets: [{ targetId: "ssh-a", hostId: 42, hostName: "A" }],
  options: {},
  pending: [],
  error: null,
  contextTokens: 0,
  contextWindow: 32768,
  updatedAt: 0,
};
function response(message: unknown, finishReason = "stop") {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "compatible-model",
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 42, completion_tokens: 10, total_tokens: 52 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}
describe("official OpenAI SDK transport", () => {
  it("sends standard function tools to the configured compatible endpoint", async () => {
    const transport = vi.fn(async () =>
      response(
        {
          role: "assistant",
          content: "Inspecting",
          tool_calls: [
            {
              id: "call-one",
              type: "function",
              function: {
                name: "run_command",
                arguments: JSON.stringify({
                  targetId: "ssh-a",
                  command: "pwd",
                }),
              },
            },
          ],
        },
        "tool_calls",
      ),
    );
    const provider = new OpenAIRuntimeModel(
      config,
      run,
      transport as unknown as typeof fetch,
    );
    const result = await provider.complete(
      [{ role: "user", content: "inspect" }],
      new AbortController().signal,
    );
    expect(result.message.toolCalls?.[0]).toMatchObject({
      name: "run_command",
      arguments: { command: "pwd" },
    });
    expect(result.promptTokens).toBe(42);
    const [url, request] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(String(url)).toBe("https://model.invalid/v1/chat/completions");
    const body = JSON.parse(request.body as string);
    expect(body.tool_choice).toBe("auto");
    expect(
      body.tools.map(
        (item: { function: { name: string } }) => item.function.name,
      ),
    ).toEqual(["run_command", "read_job_output", "cancel_job"]);
  });
  it("never includes execution tools in a summary request", async () => {
    const transport = vi.fn(async () =>
      response({ role: "assistant", content: "Accurate prior observations" }),
    );
    const provider = new OpenAIRuntimeModel(
      config,
      run,
      transport as unknown as typeof fetch,
    );
    await expect(
      provider.summarize(
        "prior",
        "observed stdout",
        new AbortController().signal,
      ),
    ).resolves.toContain("observations");
    const request = (
      transport.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    expect(JSON.parse(request.body as string).tools).toBeUndefined();
  });
  it.each([
    [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "bad",
            type: "function",
            function: { name: "run_command", arguments: "{" },
          },
        ],
      },
      "stop",
    ],
    [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "bad",
            type: "function",
            function: { name: "unknown_tool", arguments: "{}" },
          },
        ],
      },
      "stop",
    ],
    [{ role: "assistant", content: "incomplete" }, "length"],
  ])(
    "rejects invalid or incomplete model results without executing",
    async (message, finish) => {
      const provider = new OpenAIRuntimeModel(
        config,
        run,
        vi.fn(async () =>
          response(message, finish as string),
        ) as unknown as typeof fetch,
      );
      await expect(
        provider.complete(
          [{ role: "user", content: "inspect" }],
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ status: 502 });
    },
  );
  it("does not retry failed model requests or silently fall back to text-only execution", async () => {
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "endpoint unavailable", type: "server_error" },
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
    );
    const provider = new OpenAIRuntimeModel(
      config,
      run,
      transport as unknown as typeof fetch,
    );
    await expect(
      provider.complete(
        [{ role: "user", content: "inspect" }],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "MODEL_REQUEST_FAILED" });
    expect(transport).toHaveBeenCalledOnce();
  });
  it("reports context rejection separately so the runtime can compact conservatively", async () => {
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "context length exceeded",
              code: "context_length_exceeded",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const provider = new OpenAIRuntimeModel(
      config,
      run,
      transport as unknown as typeof fetch,
    );
    await expect(
      provider.complete(
        [{ role: "user", content: "inspect" }],
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(transport).toHaveBeenCalledOnce();
  });
});

it("retains the current user's image and text attachment through compaction", () => {
  const messages = basePrompt(
    config,
    run,
    {
      id: "current-task",
      role: "user",
      content: "inspect this",
      attachments: [
        {
          id: "image",
          kind: "image",
          name: "diagram.png",
          mimeType: "image/png",
          size: 3,
          dataUrl: "data:image/png;base64,YWJj",
        },
        {
          id: "text",
          kind: "text",
          name: "notes.txt",
          mimeType: "text/plain",
          size: 5,
          text: "important instruction",
        },
      ],
    },
    [],
  );
  expect(JSON.stringify(messages)).toContain("data:image/png;base64,YWJj");
  expect(JSON.stringify(messages)).toContain("important instruction");
});

it("describes shared-terminal shell semantics to the model", () => {
  const messages = basePrompt(
    config,
    {
      ...run,
      options: { sshMode: "shared-terminal" },
      targets: [
        {
          targetId: "ssh-a",
          hostId: 42,
          hostName: "A",
          terminalSessionId: "terminal-session-123",
        },
      ],
    },
    { id: "task-shared", role: "user", content: "pwd" },
    [],
  );
  const prompt = JSON.stringify(messages);
  expect(prompt).toContain("selected live SSH PTY");
  expect(prompt).toContain("protected non-interactive child sh");
  expect(prompt).toContain("directory and exported environment are inherited");
  expect(prompt).toContain("NOT the human login shell or the next command");
  expect(prompt).toContain("Standard input is closed");
});
