import { isIP } from "node:net";
import type Database from "better-sqlite3";
import { isAddressAllowedByCidrs } from "../utils/trust-loopback-proxy.js";

export interface AgentHttpPolicy {
  allowHttp: boolean;
  allowedCidrs: string[];
}
const KEY = "agent_lan_http_policy_v1";
const PRIVATE_NETWORKS: Array<[string, number]> = [
  ["10.0.0.0/8", 8],
  ["172.16.0.0/12", 12],
  ["192.168.0.0/16", 16],
  ["100.64.0.0/10", 10],
  ["fc00::/7", 7],
  ["fe80::/10", 10],
];
const enabled = (value: string | undefined) =>
  /^(1|true|yes|on)$/i.test(value?.trim() || "");
const failure = (message: string, code = "INVALID_HTTP_POLICY") =>
  Object.assign(new Error(message), { status: 400, code });

export function isPrivateAgentAddress(address: string | undefined): boolean {
  return PRIVATE_NETWORKS.some(([cidr]) =>
    isAddressAllowedByCidrs(address, cidr),
  );
}

export function validateAgentHttpPolicy(value: unknown): AgentHttpPolicy {
  const v = value as Partial<AgentHttpPolicy> | null;
  if (
    !v ||
    typeof v.allowHttp !== "boolean" ||
    !Array.isArray(v.allowedCidrs) ||
    v.allowedCidrs.length > 32
  ) {
    throw failure("需要开关和最多 32 个可信内网 CIDR");
  }
  const allowedCidrs = [
    ...new Set(
      v.allowedCidrs.map((raw) => {
        if (typeof raw !== "string" || raw.length > 80)
          throw failure("CIDR 格式无效");
        const parts = raw.trim().toLowerCase().split("/");
        const address = parts[0];
        const family = isIP(address);
        if (!family || parts.length > 2 || address.startsWith("::ffff:"))
          throw failure("请填写真实 IPv4 / IPv6 内网地址或 CIDR");
        const bits = family === 4 ? 32 : 128;
        const prefix =
          parts.length === 1
            ? bits
            : /^\d{1,3}$/.test(parts[1])
              ? Number(parts[1])
              : -1;
        if (
          prefix < 0 ||
          prefix > bits ||
          !PRIVATE_NETWORKS.some(
            ([network, minimum]) =>
              prefix >= minimum && isAddressAllowedByCidrs(address, network),
          )
        ) {
          throw failure(
            "只允许明确的可信内网/VPN网段，不能允许公网或 0.0.0.0/0",
          );
        }
        return `${address}/${prefix}`;
      }),
    ),
  ];
  if (v.allowHttp && allowedCidrs.length === 0)
    throw failure("开启 HTTP 前必须填写允许的来源 CIDR");
  return { allowHttp: v.allowHttp, allowedCidrs };
}

export class AgentHttpPolicyStore {
  private saved: AgentHttpPolicy | null = null;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private sqlite: Database.Database,
    private persist: () => void | Promise<void>,
    private env: NodeJS.ProcessEnv = process.env,
  ) {
    const row = sqlite
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(KEY) as { value: string } | undefined;
    if (row) {
      try {
        this.saved = validateAgentHttpPolicy(JSON.parse(row.value));
      } catch {
        this.saved = { allowHttp: false, allowedCidrs: [] };
      }
    }
  }
  snapshot() {
    const locked = enabled(this.env.CLOUDSSH_AGENT_HTTP_POLICY_LOCKED);
    const policy =
      !locked && this.saved
        ? this.saved
        : {
            allowHttp: enabled(this.env.CLOUDSSH_AGENT_ALLOW_HTTP),
            allowedCidrs: (this.env.CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS || "")
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
          };
    return {
      ...policy,
      allowedCidrs: [...policy.allowedCidrs],
      locked,
      source: !locked && this.saved ? "saved" : "environment",
    };
  }
  update(
    value: unknown,
    audit: (policy: AgentHttpPolicy) => Promise<void>,
  ): Promise<void> {
    const next = validateAgentHttpPolicy(value);
    const operation = this.queue.then(async () => {
      if (this.snapshot().locked)
        throw Object.assign(
          new Error("此部署已锁定环境变量策略，网页不能覆盖"),
          { status: 409, code: "HTTP_POLICY_LOCKED" },
        );
      await audit(next);
      const before = this.sqlite
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(KEY) as { value: string } | undefined;
      const upsert = this.sqlite.prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      );
      upsert.run(KEY, JSON.stringify(next));
      try {
        await this.persist();
      } catch (error) {
        if (before) upsert.run(KEY, before.value);
        else this.sqlite.prepare("DELETE FROM settings WHERE key = ?").run(KEY);
        await this.persist();
        throw error;
      }
      // Never make an unpersisted grant effective while a save is in flight.
      this.saved = next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
