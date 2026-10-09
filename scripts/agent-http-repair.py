from pathlib import Path


def replace(name, before, after):
    p = Path(name)
    source = p.read_text()
    if after in source:
        return
    if source.count(before) != 1:
        raise RuntimeError(f'{name}: anchor count {source.count(before)}: {before[:70]}')
    p.write_text(source.replace(before, after))


def write(name, body):
    p = Path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body)


write('src/backend/agent/http-policy.ts', r'''import { isIP } from "node:net";
import type Database from "better-sqlite3";
import { isAddressAllowedByCidrs } from "../utils/trust-loopback-proxy.js";

export interface AgentHttpPolicy { allowHttp: boolean; allowedCidrs: string[] }
const KEY = "agent_lan_http_policy_v1";
const PRIVATE_NETWORKS: Array<[string, number]> = [
  ["10.0.0.0/8", 8], ["172.16.0.0/12", 12], ["192.168.0.0/16", 16],
  ["100.64.0.0/10", 10], ["fc00::/7", 7], ["fe80::/10", 10],
];
const enabled = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value?.trim() || "");
const failure = (message: string, code = "INVALID_HTTP_POLICY") => Object.assign(new Error(message), { status: 400, code });

export function isPrivateAgentAddress(address: string | undefined): boolean {
  return PRIVATE_NETWORKS.some(([cidr]) => isAddressAllowedByCidrs(address, cidr));
}

export function validateAgentHttpPolicy(value: unknown): AgentHttpPolicy {
  const v = value as Partial<AgentHttpPolicy> | null;
  if (!v || typeof v.allowHttp !== "boolean" || !Array.isArray(v.allowedCidrs) || v.allowedCidrs.length > 32) {
    throw failure("需要开关和最多 32 个可信内网 CIDR");
  }
  const allowedCidrs = [...new Set(v.allowedCidrs.map((raw) => {
    if (typeof raw !== "string" || raw.length > 80) throw failure("CIDR 格式无效");
    const parts = raw.trim().toLowerCase().split("/");
    const address = parts[0];
    const family = isIP(address);
    if (!family || parts.length > 2 || address.startsWith("::ffff:")) throw failure("请填写真实 IPv4 / IPv6 内网地址或 CIDR");
    const bits = family === 4 ? 32 : 128;
    const prefix = parts.length === 1 ? bits : /^\d{1,3}$/.test(parts[1]) ? Number(parts[1]) : -1;
    if (prefix < 0 || prefix > bits || !PRIVATE_NETWORKS.some(([network, minimum]) => prefix >= minimum && isAddressAllowedByCidrs(address, network))) {
      throw failure("只允许明确的可信内网/VPN网段，不能允许公网或 0.0.0.0/0");
    }
    return `${address}/${prefix}`;
  }))];
  if (v.allowHttp && allowedCidrs.length === 0) throw failure("开启 HTTP 前必须填写允许的来源 CIDR");
  return { allowHttp: v.allowHttp, allowedCidrs };
}

export class AgentHttpPolicyStore {
  private saved: AgentHttpPolicy | null = null;
  private queue: Promise<void> = Promise.resolve();
  constructor(private sqlite: Database.Database, private persist: () => void | Promise<void>, private env: NodeJS.ProcessEnv = process.env) {
    const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    if (row) {
      try { this.saved = validateAgentHttpPolicy(JSON.parse(row.value)); }
      catch { this.saved = { allowHttp: false, allowedCidrs: [] }; }
    }
  }
  snapshot() {
    const locked = enabled(this.env.CLOUDSSH_AGENT_HTTP_POLICY_LOCKED);
    const policy = !locked && this.saved ? this.saved : {
      allowHttp: enabled(this.env.CLOUDSSH_AGENT_ALLOW_HTTP),
      allowedCidrs: (this.env.CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS || "").split(",").map(x => x.trim()).filter(Boolean),
    };
    return { ...policy, allowedCidrs: [...policy.allowedCidrs], locked, source: !locked && this.saved ? "saved" : "environment" };
  }
  update(value: unknown, audit: (policy: AgentHttpPolicy) => Promise<void>): Promise<void> {
    const next = validateAgentHttpPolicy(value);
    const operation = this.queue.then(async () => {
      if (this.snapshot().locked) throw Object.assign(new Error("此部署已锁定环境变量策略，网页不能覆盖"), { status: 409, code: "HTTP_POLICY_LOCKED" });
      await audit(next);
      const before = this.sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as {value: string} | undefined;
      const upsert = this.sqlite.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      upsert.run(KEY, JSON.stringify(next));
      try { await this.persist(); }
      catch (error) {
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
''')

write('src/backend/agent/http-policy-router.ts', r'''import express from "express";
import type { AuthenticatedRequest } from "../../types/index.js";
import { getRequestMeta } from "../utils/audit-logger.js";
import { isAdministrativeTransportAllowed, isAgentTransportAllowed } from "../utils/trust-loopback-proxy.js";
import { requireRecentMfa, type AgentDeviceAdminDependencies } from "./device-admin.js";
import { AgentHttpPolicyStore, isPrivateAgentAddress } from "./http-policy.js";

export function createAgentHttpPolicyRouter(deps: AgentDeviceAdminDependencies, store: AgentHttpPolicyStore) {
  const router = express.Router();
  router.use(deps.authenticate);
  router.use(async (req, res, next) => {
    try {
      const auth = req as AuthenticatedRequest;
      if (auth.apiKeyId || !auth.sessionId || auth.pendingTOTP) return res.status(401).json({ code: "INTERACTIVE_SESSION_REQUIRED", error: "只允许完成登录的管理员网页会话" });
      if (!(await deps.isInstanceAdmin(auth.userId))) return res.status(403).json({ code: "ADMIN_REQUIRED", error: "只允许实例管理员修改传输策略" });
      res.setHeader("Cache-Control", "private, no-store");
      next();
    } catch (error) { next(error); }
  });
  const bootstrapAllowed = (req: express.Request) =>
    isAdministrativeTransportAllowed(req, "production", { ...process.env, CLOUDSSH_AGENT_ALLOW_HTTP: "false", CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS: "" }) || isPrivateAgentAddress(req.ip);
  router.get("/", (req, res) => {
    res.json({ ...store.snapshot(), sourceAddress: req.ip || null, currentRequestAllowed: isAgentTransportAllowed(req), canConfigure: bootstrapAllowed(req) });
  });
  router.post("/", async (req, res, next) => {
    try {
      if (!bootstrapAllowed(req)) return res.status(426).json({ code: "HTTPS_REQUIRED", error: "公网管理必须使用 HTTPS；内网首次开启需从真实内网来源访问" });
      // Browser Origin is mandatory for this security-policy mutation. The
      // proxy must preserve Host; arbitrary forwarded headers are not trusted.
      const origin = req.get("origin");
      let sameOrigin = false;
      try { const parsed = new URL(origin || ""); sameOrigin = parsed.host === req.get("host") && parsed.protocol === `${req.protocol}:`; } catch { /* reject */ }
      if (!sameOrigin) return res.status(403).json({ code: "ORIGIN_REQUIRED", error: "请从 CloudSSH 同源管理页面保存配置" });
      if (!requireRecentMfa(deps, req, res)) return;
      if (!deps.audit) throw new Error("Audit persistence unavailable");
      const auth = req as AuthenticatedRequest;
      await store.update(req.body, policy => deps.audit!({
        userId: auth.userId, username: auth.user?.username || auth.userId,
        action: "agent_http_policy_change_intent", resourceType: "agent_transport_policy",
        details: JSON.stringify({ before: store.snapshot(), after: policy }),
        ...getRequestMeta(req), success: true,
      }));
      res.json({ ...store.snapshot(), sourceAddress: req.ip || null, currentRequestAllowed: isAgentTransportAllowed(req), canConfigure: bootstrapAllowed(req) });
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const v = error as { status?: number; code?: string; message?: string };
    res.status(v.status || 500).json({ code: v.code || "HTTP_POLICY_SAVE_FAILED", error: v.status ? v.message : "配置保存或审计失败，未启用新的 HTTP 授权" });
  });
  return router;
}
''')

# Only Agent transport uses the UI policy. Credential export and unrelated
# administrative HTTPS requirements are deliberately not weakened.
p = Path('src/backend/utils/trust-loopback-proxy.ts')
s = p.read_text()
if 'export function setAgentHttpPolicyProvider' not in s:
    s += r'''

type AgentHttpPolicyValue = { allowHttp: boolean; allowedCidrs: string[] };
let agentHttpPolicyProvider: (() => AgentHttpPolicyValue) | undefined;
export function setAgentHttpPolicyProvider(provider?: () => AgentHttpPolicyValue): void {
  agentHttpPolicyProvider = provider;
}
export function isAgentTransportAllowed(
  request: TransportRequest,
  environment = process.env.NODE_ENV,
  variables: NodeJS.ProcessEnv = process.env,
): boolean {
  let policy: AgentHttpPolicyValue | undefined;
  try { policy = agentHttpPolicyProvider?.(); }
  catch { policy = { allowHttp: false, allowedCidrs: [] }; }
  return isAdministrativeTransportAllowed(request, environment, policy ? {
    ...variables,
    CLOUDSSH_AGENT_ALLOW_HTTP: policy.allowHttp ? "true" : "false",
    CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS: policy.allowedCidrs.join(","),
  } : variables);
}
'''
    p.write_text(s)
p = Path('src/backend/agent/routes.ts')
p.write_text(p.read_text().replace('isAdministrativeTransportAllowed', 'isAgentTransportAllowed'))
replace('src/backend/agent/device-admin.ts', 'function requireRecentMfa(', 'export function requireRecentMfa(')
p = Path('src/backend/agent/index.ts')
s = p.read_text()
if 'import { AgentHttpPolicyStore }' not in s:
    s = 'import { AgentHttpPolicyStore } from "./http-policy.js";\nimport { createAgentHttpPolicyRouter } from "./http-policy-router.js";\nimport { setAgentHttpPolicyProvider } from "../utils/trust-loopback-proxy.js";\n' + s
p.write_text(s)
replace('src/backend/agent/index.ts', 'app.use(cookieParser());', '''app.use(cookieParser());
const httpPolicyStore = new AgentHttpPolicyStore(sqlite, forceDeviceSecuritySave);
setAgentHttpPolicyProvider(() => httpPolicyStore.snapshot());
app.use("/agent/admin/v1/transport-policy", createAgentHttpPolicyRouter(
  defaultAgentDeviceAdminDependencies(sqlite, forceDeviceSecuritySave), httpPolicyStore,
));''')

write('src/ui/sidebar/AdminAgentHttpSettings.tsx', r'''import { useCallback, useEffect, useState } from "react";
import { agentApi } from "@/main-axios";
import { Button } from "@/components/button";
import { Textarea } from "@/components/textarea";
import { toast } from "sonner";

interface Policy { allowHttp: boolean; allowedCidrs: string[]; locked: boolean; source: string; sourceAddress: string | null; currentRequestAllowed: boolean; canConfigure: boolean }
const endpoint = "/agent/admin/v1/transport-policy";
function message(error: unknown) {
  return (error as {response?: {data?: {error?: string}}})?.response?.data?.error || "读取或保存 Agent HTTP 设置失败";
}
export function AdminAgentHttpSettings({ active }: { active: boolean }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [allowHttp, setAllowHttp] = useState(false);
  const [cidrs, setCidrs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const accept = useCallback((value: Policy) => {
    setPolicy(value); setAllowHttp(value.allowHttp); setCidrs(value.allowedCidrs.join("\n")); setError("");
  }, []);
  const load = useCallback(async () => {
    setBusy(true);
    try { accept((await agentApi.get(endpoint)).data); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }, [accept]);
  useEffect(() => { if (active) void load(); }, [active, load]);
  async function save() {
    const allowedCidrs = cidrs.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
    if (allowHttp && !allowedCidrs.length) { setError("请先填写允许访问的客户端来源 CIDR"); return; }
    if (!window.confirm(allowHttp ? "启用指定可信内网的 Agent HTTP？HTTP 不加密传输内容；该设置保存后立即生效。" : "关闭内网 Agent HTTP？未使用 HTTPS 的设备后续请求将被拒绝。")) return;
    setBusy(true);
    try {
      accept((await agentApi.post(endpoint, { allowHttp, allowedCidrs })).data);
      toast.success("Agent HTTP 设置已保存并生效，无需重建容器");
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  return <section className="space-y-2 rounded-xl border border-border p-3" aria-label="Agent 内网 HTTP">
    <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-semibold">Agent 内网 HTTP</h3><Button size="xs" variant="outline" disabled={busy} onClick={() => void load()}>刷新状态</Button></div>
    <p className="text-xs text-muted-foreground">仅用于你控制的可信内网。设备审批、签名及项目权限不变；公网仍请使用 HTTPS。保存需要近期二次验证。</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {policy && <>
      <p className="text-xs text-muted-foreground">当前来源：{policy.sourceAddress || "未知"}；配置来源：{policy.source === "saved" ? "管理界面" : "环境变量"}</p>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" role="switch" aria-label="允许内网 Agent HTTP" checked={allowHttp} disabled={busy || policy.locked || !policy.canConfigure} onChange={event => setAllowHttp(event.target.checked)} />允许指定内网来源使用 HTTP</label>
      <label className="block text-xs">允许来源 CIDR（每行一个；应填客户端来源，不是 SSH 目标地址）<Textarea aria-label="允许来源 CIDR" className="mt-1 min-h-20 font-mono text-xs" value={cidrs} placeholder="例如：192.168.222.10/32" disabled={busy || policy.locked || !policy.canConfigure} onChange={event => setCidrs(event.target.value)} /></label>
      {policy.locked && <p className="text-xs text-amber-600">部署者已用 CLOUDSSH_AGENT_HTTP_POLICY_LOCKED 锁定配置，网页不能覆盖。</p>}
      {!policy.canConfigure && <p className="text-xs text-amber-600">请从 HTTPS 或真实内网来源打开管理界面。</p>}
      <Button size="sm" disabled={busy || policy.locked || !policy.canConfigure} onClick={() => void save()}>保存 HTTP 设置</Button>
    </>}
  </section>;
}
''')
p = Path('src/ui/sidebar/AdminPanelAgentSection.tsx')
s = p.read_text()
if 'import { AdminAgentHttpSettings }' not in s:
    s = 'import { AdminAgentHttpSettings } from "./AdminAgentHttpSettings";\n' + s
p.write_text(s)
replace('src/ui/sidebar/AdminPanelAgentSection.tsx', '<div className="space-y-3 pt-3">', '<div className="space-y-3 pt-3">\n        <AdminAgentHttpSettings active={open} />')

write('src/backend/agent/http-policy.test.ts', r'''import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHttpPolicyStore, validateAgentHttpPolicy } from "./http-policy.js";
import { isAgentTransportAllowed, isAdministrativeTransportAllowed, setAgentHttpPolicyProvider } from "../utils/trust-loopback-proxy.js";

afterEach(() => setAgentHttpPolicyProvider(undefined));
function database() { const db = new Database(":memory:"); db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT)"); return db; }
describe("Agent LAN HTTP policy", () => {
  it.each(["0.0.0.0/0", "192.168.0.0/8", "203.0.113.1/32", "192.168.1.1/24abc", "::/0", "2001:db8::/32"])("rejects broad, public or invalid range %s", cidr => {
    expect(() => validateAgentHttpPolicy({allowHttp: true, allowedCidrs: [cidr]})).toThrow();
  });
  it("requires an explicit nonempty source list", () => {
    expect(() => validateAgentHttpPolicy({allowHttp: true, allowedCidrs: []})).toThrow();
    expect(validateAgentHttpPolicy({allowHttp: true, allowedCidrs: ["192.168.222.10"]}).allowedCidrs).toEqual(["192.168.222.10/32"]);
  });
  it("persists across store recreation and takes effect without touching other admin policies", async () => {
    const db = database();
    const store = new AgentHttpPolicyStore(db, async () => {}, {});
    await store.update({allowHttp: true, allowedCidrs: ["192.168.222.0/24"]}, async () => {});
    const restored = new AgentHttpPolicyStore(db, async () => {}, {});
    setAgentHttpPolicyProvider(() => restored.snapshot());
    const req = { secure: false, ip: "192.168.222.10" };
    expect(isAgentTransportAllowed(req, "production", {})).toBe(true);
    expect(isAdministrativeTransportAllowed(req, "production", {})).toBe(false);
    expect(isAgentTransportAllowed({secure: false, ip: "203.0.113.1"}, "production", {})).toBe(false);
    db.close();
  });
  it("does not publish failed writes or audit failures", async () => {
    const db = database();
    const persist = vi.fn().mockRejectedValueOnce(new Error("disk error")).mockResolvedValue(undefined);
    const store = new AgentHttpPolicyStore(db, persist, {});
    await expect(store.update({allowHttp: true, allowedCidrs: ["10.0.0.1/32"]}, async () => {})).rejects.toThrow("disk error");
    expect(store.snapshot().allowHttp).toBe(false);
    await expect(store.update({allowHttp: true, allowedCidrs: ["10.0.0.1/32"]}, async () => {throw new Error("audit error");})).rejects.toThrow("audit error");
    expect(db.prepare("SELECT * FROM settings").all()).toEqual([]);
    db.close();
  });
  it("honors an explicitly locked deployment", async () => {
    const db = database();
    const store = new AgentHttpPolicyStore(db, async () => {}, {CLOUDSSH_AGENT_HTTP_POLICY_LOCKED: "true"});
    await expect(store.update({allowHttp: true, allowedCidrs: ["10.0.0.1/32"]}, async () => {})).rejects.toThrow("锁定");
    db.close();
  });
});
''')
print('Prepared admin-only Agent LAN HTTP settings')
