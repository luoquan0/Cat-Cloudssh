import { describe, expect, it } from "vitest";
import { parseStartRuntime } from "./input.js";

function request(message: Record<string, unknown>) {
  return {
    requestId: "request_12345678",
    message,
    targets: [],
    options: {},
  };
}

describe("panel runtime input validation", () => {
  it("reports an invalid user message ID instead of a role error", () => {
    expect(() =>
      parseStartRuntime(
        request({
          id: "1790998123456-0.428371928",
          role: "user",
          content: "查看当前机器内存占用",
        }),
      ),
    ).toThrow("消息标识无效，请刷新页面后重试");
  });

  it("rejects client-supplied tool calls with a dedicated error", () => {
    expect(() =>
      parseStartRuntime(
        request({
          id: "message_12345678",
          role: "user",
          content: "inspect",
          toolCalls: [],
        }),
      ),
    ).toThrow("工具调用只能由后端生成");
  });
});
