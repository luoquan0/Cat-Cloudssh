import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({get: vi.fn(), post: vi.fn()}));
const notices = vi.hoisted(() => ({success: vi.fn()}));
vi.mock("@/main-axios", () => ({agentApi: api}));
vi.mock("sonner", () => ({toast: notices}));
import { AdminAgentHttpSettings } from "@/sidebar/AdminAgentHttpSettings";
const initial = {
  allowHttp: false, allowedCidrs: [], locked: false, source: "environment",
  sourceAddress: "192.168.222.10", currentRequestAllowed: false, canConfigure: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({data: initial});
  api.post.mockResolvedValue({data: {...initial, allowHttp: true, allowedCidrs: ["192.168.222.10/32"], source: "saved"}});
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("Agent LAN HTTP settings", () => {
  it("loads on open and saves explicit source ranges", async () => {
    const view = render(<AdminAgentHttpSettings active={false} />);
    expect(api.get).not.toHaveBeenCalled();
    view.rerender(<AdminAgentHttpSettings active />);
    fireEvent.click(await screen.findByRole("switch", {name: "允许内网 Agent HTTP"}));
    fireEvent.change(screen.getByRole("textbox", {name: /允许来源 CIDR/}), {target: {value: "192.168.222.10/32"}});
    fireEvent.click(screen.getByRole("button", {name: "保存 HTTP 设置"}));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/agent/admin/v1/transport-policy", {allowHttp: true, allowedCidrs: ["192.168.222.10/32"]}));
    expect(window.confirm).toHaveBeenCalledOnce();
  });
  it("does not permit empty enabled ranges", async () => {
    render(<AdminAgentHttpSettings active />);
    fireEvent.click(await screen.findByRole("switch", {name: "允许内网 Agent HTTP"}));
    fireEvent.click(screen.getByRole("button", {name: "保存 HTTP 设置"}));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "请先填写允许访问的客户端来源 CIDR");
    expect(api.post).not.toHaveBeenCalled();
  });
  it("honors locked deployments and displays the backend reason on failure", async () => {
    api.get.mockResolvedValue({data: {...initial, locked: true}});
    render(<AdminAgentHttpSettings active />);
    expect(await screen.findByRole("switch", {name: "允许内网 Agent HTTP"})).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", {name: "保存 HTTP 设置"})).toHaveProperty("disabled", true);
    expect(api.post).not.toHaveBeenCalled();
  });
  it("shows recent-MFA errors without claiming a successful save", async () => {
    api.post.mockRejectedValue({response: {data: {error: "请重新完成二次验证"}}});
    render(<AdminAgentHttpSettings active />);
    await screen.findByRole("switch", {name: "允许内网 Agent HTTP"});
    fireEvent.click(screen.getByRole("button", {name: "保存 HTTP 设置"}));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "请重新完成二次验证");
    expect(notices.success).not.toHaveBeenCalled();
  });
});
