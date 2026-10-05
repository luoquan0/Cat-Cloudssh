import { describe, expect, it } from "vitest";
import {
  isAddressAllowedByCidrs,
  isAdministrativeTransportAllowed,
  isLoopbackAddress,
  trustLoopbackProxy,
} from "../../utils/trust-loopback-proxy.js";

type TransportRequest = Parameters<typeof isAdministrativeTransportAllowed>[0];

function request(input: {
  secure?: boolean;
  ip: string;
  remoteAddress?: string;
  forwardedProto?: string;
}): TransportRequest {
  return {
    secure: input.secure ?? false,
    ip: input.ip,
    ...(input.remoteAddress
      ? {
          socket: { remoteAddress: input.remoteAddress },
          headers: input.forwardedProto
            ? { "x-forwarded-proto": input.forwardedProto }
            : {},
        }
      : {}),
  } as TransportRequest;
}

describe("trustLoopbackProxy", () => {
  it("默认仅信任本机反向代理的第一跳", () => {
    expect(trustLoopbackProxy("127.0.0.1", 0)).toBe(true);
    expect(trustLoopbackProxy("::ffff:127.0.0.1", 0)).toBe(true);
    expect(trustLoopbackProxy("::1", 0)).toBe(true);
    expect(trustLoopbackProxy("127.0.0.1", 1)).toBe(false);
    expect(trustLoopbackProxy("198.51.100.10", 0)).toBe(false);
  });

  it("仅在显式 trusted proxy CIDR 中信任非回环第一跳", () => {
    const environment = {
      CLOUDSSH_TRUSTED_PROXY_CIDR: "172.16.0.0/12,2001:db8:1234::/48",
    };
    expect(trustLoopbackProxy("172.18.0.1", 0, environment)).toBe(true);
    expect(trustLoopbackProxy("::ffff:172.18.0.1", 0, environment)).toBe(true);
    expect(trustLoopbackProxy("2001:db8:1234::10", 0, environment)).toBe(true);
    expect(trustLoopbackProxy("192.168.1.10", 0, environment)).toBe(false);
    expect(trustLoopbackProxy("172.18.0.1", 1, environment)).toBe(false);
  });

  it("production + HTTPS 始终允许", () => {
    expect(
      isAdministrativeTransportAllowed(
        request({ secure: true, ip: "198.51.100.10" }),
        "production",
        {},
      ),
    ).toBe(true);
  });

  it("production + localhost HTTP 允许", () => {
    expect(
      isAdministrativeTransportAllowed(
        request({ ip: "127.0.0.1" }),
        "production",
        {},
      ),
    ).toBe(true);
    expect(
      isAdministrativeTransportAllowed(
        request({ ip: "::ffff:127.0.0.1" }),
        "production",
        {},
      ),
    ).toBe(true);
  });

  it("production + LAN HTTP + allow=false 返回拒绝", () => {
    expect(
      isAdministrativeTransportAllowed(
        request({ ip: "192.168.1.10" }),
        "production",
        {
          CLOUDSSH_AGENT_ALLOW_HTTP: "false",
          CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS: "192.168.0.0/16",
        },
      ),
    ).toBe(false);
  });

  it("production + LAN HTTP + allow=true + 来源在 CIDR 时允许", () => {
    expect(
      isAdministrativeTransportAllowed(
        request({ ip: "192.168.222.10" }),
        "production",
        {
          CLOUDSSH_AGENT_ALLOW_HTTP: "true",
          CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS:
            "192.168.0.0/16,10.0.0.0/8,172.16.0.0/12",
        },
      ),
    ).toBe(true);
  });

  it("production + LAN HTTP + allow=true + 来源不在 CIDR 时拒绝", () => {
    expect(
      isAdministrativeTransportAllowed(
        request({ ip: "203.0.113.10" }),
        "production",
        {
          CLOUDSSH_AGENT_ALLOW_HTTP: "true",
          CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS: "192.168.0.0/16",
        },
      ),
    ).toBe(false);
  });

  it("allow HTTP 未配置 CIDR 时不会默认允许公网或任意来源", () => {
    expect(
      isAdministrativeTransportAllowed(
        request({ ip: "192.168.1.10" }),
        "production",
        { CLOUDSSH_AGENT_ALLOW_HTTP: "true" },
      ),
    ).toBe(false);
  });

  it("伪造 X-Forwarded-Proto 不能让不可信直连来源绕过 HTTPS", () => {
    expect(
      isAdministrativeTransportAllowed(
        request({
          ip: "198.51.100.10",
          remoteAddress: "198.51.100.10",
          forwardedProto: "https",
        }),
        "production",
        {},
      ),
    ).toBe(false);
  });

  it("只接受可信第一跳代理提供的 HTTPS 协议信息", () => {
    expect(
      isAdministrativeTransportAllowed(
        request({
          ip: "198.51.100.10",
          remoteAddress: "172.18.0.2",
          forwardedProto: "https",
        }),
        "production",
        { CLOUDSSH_TRUSTED_PROXY_CIDR: "172.16.0.0/12" },
      ),
    ).toBe(true);
  });

  it("non-production HTTP 保持开发环境兼容", () => {
    expect(
      isAdministrativeTransportAllowed(
        request({ ip: "198.51.100.10" }),
        "test",
        {},
      ),
    ).toBe(true);
  });

  it("正确识别 IPv4、IPv4-mapped IPv6 和 IPv6 CIDR", () => {
    expect(isAddressAllowedByCidrs("192.168.10.20", "192.168.0.0/16")).toBe(
      true,
    );
    expect(
      isAddressAllowedByCidrs("::ffff:192.168.10.20", "192.168.0.0/16"),
    ).toBe(true);
    expect(
      isAddressAllowedByCidrs("2001:db8:1234::10", "2001:db8:1234::/48"),
    ).toBe(true);
    expect(
      isAddressAllowedByCidrs("2001:db8:ffff::10", "2001:db8:1234::/48"),
    ).toBe(false);
  });

  it("只将回环地址识别为本机", () => {
    expect(isLoopbackAddress("127.0.0.5")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("172.18.0.1")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
