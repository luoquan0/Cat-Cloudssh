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

  it("accepts shared-terminal mode only with one live terminal session id", () => {
    const parsed = parseStartRuntime({
      requestId: "request_12345678",
      message: {
        id: "message_12345678",
        role: "user",
        content: "pwd",
      },
      targets: [
        {
          targetId: "tab-12345678",
          hostId: 42,
          hostName: "test",
          terminalSessionId: "terminal-session-123",
        },
      ],
      options: { sshMode: "shared-terminal" },
    });
    expect(parsed.options.sshMode).toBe("shared-terminal");
    expect(parsed.targets[0].terminalSessionId).toBe("terminal-session-123");

    expect(() =>
      parseStartRuntime({
        requestId: "request_87654321",
        message: {
          id: "message_87654321",
          role: "user",
          content: "pwd",
        },
        targets: [{ targetId: "tab-87654321", hostId: 42, hostName: "test" }],
        options: { sshMode: "shared-terminal" },
      }),
    ).toThrow("共享当前 SSH 需要选择一个已连接终端");
  });

  it("accepts auto execution mode and rejects unknown approval modes", () => {
    const base = request({
      id: "message_approval_123",
      role: "user",
      content: "restart nginx",
    });
    const parsed = parseStartRuntime({
      ...base,
      options: { approvalMode: "auto" },
    });
    expect(parsed.options.approvalMode).toBe("auto");

    expect(() =>
      parseStartRuntime({
        ...base,
        options: { approvalMode: "always-trust" },
      }),
    ).toThrow("命令确认方式无效");
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
