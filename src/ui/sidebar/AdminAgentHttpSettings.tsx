import { useCallback, useEffect, useState } from "react";
import { agentApi } from "@/main-axios";
import { Button } from "@/components/button";
import { Textarea } from "@/components/textarea";
import { toast } from "sonner";

interface Policy {
  allowHttp: boolean;
  allowedCidrs: string[];
  locked: boolean;
  source: string;
  sourceAddress: string | null;
  currentRequestAllowed: boolean;
  canConfigure: boolean;
}
const endpoint = "/agent/admin/v1/transport-policy";
function message(error: unknown) {
  return (
    (error as { response?: { data?: { error?: string } } })?.response?.data
      ?.error || "读取或保存 Agent HTTP 设置失败"
  );
}
export function AdminAgentHttpSettings({ active }: { active: boolean }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [allowHttp, setAllowHttp] = useState(false);
  const [cidrs, setCidrs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const accept = useCallback((value: Policy) => {
    setPolicy(value);
    setAllowHttp(value.allowHttp);
    setCidrs(value.allowedCidrs.join("\n"));
    setError("");
  }, []);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      accept((await agentApi.get(endpoint)).data);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }, [accept]);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  async function save() {
    const allowedCidrs = cidrs
      .split(/[\n,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (allowHttp && !allowedCidrs.length) {
      setError("请先填写允许访问的客户端来源 CIDR");
      return;
    }
    if (
      !window.confirm(
        allowHttp
          ? "启用指定可信内网的 Agent HTTP？HTTP 不加密传输内容；该设置保存后立即生效。"
          : "关闭内网 Agent HTTP？未使用 HTTPS 的设备后续请求将被拒绝。",
      )
    )
      return;
    setBusy(true);
    try {
      accept((await agentApi.post(endpoint, { allowHttp, allowedCidrs })).data);
      toast.success("Agent HTTP 设置已保存并生效，无需重建容器");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="space-y-2 rounded-xl border border-border p-3"
      aria-label="Agent 内网 HTTP"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">Agent 内网 HTTP</h3>
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void load()}
        >
          刷新状态
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        仅用于你控制的可信内网。设备审批、签名及项目权限不变；公网仍请使用
        HTTPS。保存需要近期二次验证。
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {policy && (
        <>
          <p className="text-xs text-muted-foreground">
            当前来源：{policy.sourceAddress || "未知"}；配置来源：
            {policy.source === "saved" ? "管理界面" : "环境变量"}
          </p>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              role="switch"
              aria-label="允许内网 Agent HTTP"
              checked={allowHttp}
              disabled={busy || policy.locked || !policy.canConfigure}
              onChange={(event) => setAllowHttp(event.target.checked)}
            />
            允许指定内网来源使用 HTTP
          </label>
          <label className="block text-xs">
            允许来源 CIDR（每行一个；应填客户端来源，不是 SSH 目标地址）
            <Textarea
              aria-label="允许来源 CIDR"
              className="mt-1 min-h-20 font-mono text-xs"
              value={cidrs}
              placeholder="例如：192.168.222.10/32"
              disabled={busy || policy.locked || !policy.canConfigure}
              onChange={(event) => setCidrs(event.target.value)}
            />
          </label>
          {policy.locked && (
            <p className="text-xs text-amber-600">
              部署者已用 CLOUDSSH_AGENT_HTTP_POLICY_LOCKED
              锁定配置，网页不能覆盖。
            </p>
          )}
          {!policy.canConfigure && (
            <p className="text-xs text-amber-600">
              请从 HTTPS 或真实内网来源打开管理界面。
            </p>
          )}
          <Button
            size="sm"
            disabled={busy || policy.locked || !policy.canConfigure}
            onClick={() => void save()}
          >
            保存 HTTP 设置
          </Button>
        </>
      )}
    </section>
  );
}
