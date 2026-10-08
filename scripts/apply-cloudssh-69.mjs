import { readFile, writeFile } from "node:fs/promises";

async function text(path) {
  return readFile(path, "utf8");
}

async function save(path, value) {
  await writeFile(path, value, "utf8");
}

async function replaceExact(path, before, after, label = path) {
  const current = await text(path);
  const count = current.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}`);
  }
  await save(path, current.replace(before, after));
}

async function replaceBetween(path, startMarker, endMarker, replacement, label = path) {
  const current = await text(path);
  const start = current.indexOf(startMarker);
  const end = current.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`${label}: replacement markers not found`);
  }
  await save(path, current.slice(0, start) + replacement + current.slice(end));
}

async function bump(path) {
  const current = await text(path);
  const next = current.split("2.6.0-cloudssh.68").join("2.6.0-cloudssh.69");
  if (next === current) throw new Error(`${path}: version 68 not found`);
  await save(path, next);
}

await save(
  "src/backend/agent/transport-settings.ts",
  `import type Database from "better-sqlite3";
import { normalizeAgentHttpAllowedCidrs } from "../utils/trust-loopback-proxy.js";

export const AGENT_HTTP_ALLOW_SETTING_KEY = "agent_http_allow";
export const AGENT_HTTP_ALLOWED_CIDRS_SETTING_KEY =
  "agent_http_allowed_cidrs";

export type AgentHttpTransportSettings = {
  allowHttp: boolean;
  allowedCidrs: string;
  source: "database" | "environment" | "default";
};

function environmentEnabled(value: string | undefined | null): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function settingValue(
  sqlite: Database.Database,
  key: string,
): string | null {
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

export function readAgentHttpTransportSettings(
  sqlite: Database.Database,
  variables: NodeJS.ProcessEnv = process.env,
): AgentHttpTransportSettings {
  const storedAllow = settingValue(sqlite, AGENT_HTTP_ALLOW_SETTING_KEY);
  const storedCidrs = settingValue(
    sqlite,
    AGENT_HTTP_ALLOWED_CIDRS_SETTING_KEY,
  );
  const rawAllow = storedAllow ?? variables.CLOUDSSH_AGENT_ALLOW_HTTP;
  const rawCidrs =
    storedCidrs ?? variables.CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS ?? "";
  const normalizedCidrs = normalizeAgentHttpAllowedCidrs(rawCidrs) ?? [];
  const source =
    storedAllow !== null || storedCidrs !== null
      ? "database"
      : variables.CLOUDSSH_AGENT_ALLOW_HTTP !== undefined ||
          variables.CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS !== undefined
        ? "environment"
        : "default";
  return {
    allowHttp: environmentEnabled(rawAllow),
    allowedCidrs: normalizedCidrs.join(","),
    source,
  };
}

export function writeAgentHttpTransportSettings(
  sqlite: Database.Database,
  input: { allowHttp: unknown; allowedCidrs: unknown },
): AgentHttpTransportSettings {
  if (typeof input.allowHttp !== "boolean") {
    throw Object.assign(new Error("allowHttp 必须是布尔值"), {
      status: 400,
      code: "INVALID_AGENT_HTTP_SETTING",
    });
  }
  if (
    typeof input.allowedCidrs !== "string" ||
    input.allowedCidrs.length > 4096
  ) {
    throw Object.assign(new Error("allowedCidrs 无效"), {
      status: 400,
      code: "INVALID_AGENT_HTTP_CIDRS",
    });
  }
  const normalized = normalizeAgentHttpAllowedCidrs(input.allowedCidrs);
  if (!normalized) {
    throw Object.assign(new Error("allowedCidrs 必须是有效的 IPv4/IPv6 CIDR 列表"), {
      status: 400,
      code: "INVALID_AGENT_HTTP_CIDRS",
    });
  }
  if (input.allowHttp && normalized.length === 0) {
    throw Object.assign(new Error("启用内网 HTTP 时必须至少配置一个来源 CIDR"), {
      status: 400,
      code: "AGENT_HTTP_CIDRS_REQUIRED",
    });
  }
  const upsert = sqlite.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  sqlite.transaction(() => {
    upsert.run(AGENT_HTTP_ALLOW_SETTING_KEY, String(input.allowHttp));
    upsert.run(AGENT_HTTP_ALLOWED_CIDRS_SETTING_KEY, normalized.join(","));
  })();
  return readAgentHttpTransportSettings(sqlite);
}

export function resolveAgentHttpTransportEnvironment(
  sqlite: Database.Database,
  variables: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const settings = readAgentHttpTransportSettings(sqlite, variables);
  return {
    ...variables,
    CLOUDSSH_AGENT_ALLOW_HTTP: String(settings.allowHttp),
    CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS: settings.allowedCidrs,
  };
}
`,
);

await replaceExact(
  "src/backend/utils/trust-loopback-proxy.ts",
  `function configuredCidrs(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
`,
  `function configuredCidrs(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function normalizeAgentHttpAllowedCidrs(
  value: string | undefined,
): string[] | null {
  const entries = configuredCidrs(value);
  if (entries.length > 64) return null;
  const normalized: string[] = [];
  for (const entry of entries) {
    const pieces = entry.split("/");
    if (pieces.length > 2) return null;
    const address = normalizeAddress(pieces[0]);
    const parsed = parsedAddress(address);
    if (!address || !parsed) return null;
    const prefix =
      pieces[1] === undefined
        ? parsed.bits
        : Number.parseInt(pieces[1], 10);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) {
      return null;
    }
    const cidr = `${address}/${prefix}`;
    if (!normalized.includes(cidr)) normalized.push(cidr);
  }
  return normalized;
}
`,
  "CIDR normalizer",
);

await replaceExact(
  "src/backend/agent/routes.ts",
  `import {
  isAdministrativeTransportAllowed,
  trustLoopbackProxy,
} from "../utils/trust-loopback-proxy.js";
import { createCorsMiddleware } from "../utils/cors-config.js";
`,
  `import {
  isAdministrativeTransportAllowed,
  trustLoopbackProxy,
} from "../utils/trust-loopback-proxy.js";
import { getCurrentRepositorySqlite } from "../database/repositories/factory.js";
import { resolveAgentHttpTransportEnvironment } from "./transport-settings.js";
import { createCorsMiddleware } from "../utils/cors-config.js";
`,
  "Agent transport imports",
);

await replaceExact(
  "src/backend/agent/routes.ts",
  `  app.use("/agent/v1", (req, res, next) => {
    if (req.path === "/health" || isAdministrativeTransportAllowed(req)) {
      next();
      return;
    }
`,
  `  app.use("/agent/v1", (req, res, next) => {
    const transportEnvironment = resolveAgentHttpTransportEnvironment(
      getCurrentRepositorySqlite(),
    );
    if (
      req.path === "/health" ||
      isAdministrativeTransportAllowed(
        req,
        process.env.NODE_ENV,
        transportEnvironment,
      )
    ) {
      next();
      return;
    }
`,
  "dynamic Agent HTTP policy",
);

await replaceExact(
  "src/backend/agent/device-admin.ts",
  `import { PermissionManager } from "../utils/permission-manager.js";
import {
  hashDeviceCode,
`,
  `import { PermissionManager } from "../utils/permission-manager.js";
import {
  readAgentHttpTransportSettings,
  writeAgentHttpTransportSettings,
} from "./transport-settings.js";
import {
  hashDeviceCode,
`,
  "Agent transport settings imports",
);

await replaceExact(
  "src/backend/agent/device-admin.ts",
  `    action: string;
    resourceId?: string;
    resourceName?: string;
    details?: Record<string, unknown>;
    success?: boolean;
`,
  `    action: string;
    resourceType?: string;
    resourceId?: string;
    resourceName?: string;
    details?: Record<string, unknown>;
    success?: boolean;
`,
  "audit resource type input",
);

await replaceExact(
  "src/backend/agent/device-admin.ts",
  `    action: input.action,
    resourceType: "agent_device",
`,
  `    action: input.action,
    resourceType: input.resourceType ?? "agent_device",
`,
  "audit resource type output",
);

await replaceExact(
  "src/backend/agent/device-admin.ts",
  `      return res.json({
        projects,
        devices: repository.list({
`,
  `      return res.json({
        projects,
        instanceAdmin: isInstanceAdmin,
        devices: repository.list({
`,
  "instance admin flag",
);

await replaceExact(
  "src/backend/agent/device-admin.ts",
  `  router.get("/devices", async (req, res, next) => {
`,
  `  router.get("/transport-settings", async (req, res, next) => {
    try {
      const { isInstanceAdmin } = await deviceManagerContext(
        dependencies,
        req,
      );
      if (!isInstanceAdmin) {
        return res.status(403).json({
          error: "只有实例管理员可以配置 Agent 传输策略",
          code: "INSTANCE_ADMIN_REQUIRED",
        });
      }
      return res.json({
        settings: readAgentHttpTransportSettings(dependencies.sqlite),
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/transport-settings", async (req, res, next) => {
    try {
      const { isInstanceAdmin } = await deviceManagerContext(
        dependencies,
        req,
      );
      if (!isInstanceAdmin) {
        return res.status(403).json({
          error: "只有实例管理员可以配置 Agent 传输策略",
          code: "INSTANCE_ADMIN_REQUIRED",
        });
      }
      if (!requireRecentMfa(dependencies, req, res)) return;
      const settings = writeAgentHttpTransportSettings(dependencies.sqlite, {
        allowHttp: req.body?.allowHttp,
        allowedCidrs: req.body?.allowedCidrs,
      });
      await dependencies.onWrite?.();
      await auditDeviceAdminAction(dependencies, req, {
        action: "update_agent_http_transport",
        resourceType: "agent_transport",
        resourceId: "http-policy",
        details: settings,
      });
      return res.json({ settings });
    } catch (error) {
      next(error);
    }
  });

  router.get("/devices", async (req, res, next) => {
`,
  "Agent HTTP admin routes",
);

await replaceExact(
  "src/ui/api/agent-admin-api.ts",
  `export type AgentAdminAccess = {
  projects: AgentProjectOption[];
  devices: AgentDevice[];
};
`,
  `export type AgentAdminAccess = {
  projects: AgentProjectOption[];
  devices: AgentDevice[];
  instanceAdmin: boolean;
};

export type AgentHttpTransportSettings = {
  allowHttp: boolean;
  allowedCidrs: string;
  source: "database" | "environment" | "default";
};
`,
  "Agent admin access type",
);

await replaceExact(
  "src/ui/api/agent-admin-api.ts",
  `      devices: Array.isArray(response.data?.devices)
        ? response.data.devices
        : [],
`,
  `      devices: Array.isArray(response.data?.devices)
        ? response.data.devices
        : [],
      instanceAdmin: response.data?.instanceAdmin === true,
`,
  "Agent admin access response",
);

await replaceExact(
  "src/ui/api/agent-admin-api.ts",
  `export async function resolveAgentDeviceCode(
`,
  `export async function getAgentHttpTransportSettings(): Promise<AgentHttpTransportSettings> {
  try {
    const response = await agentApi.get(
      `${AGENT_ADMIN_PREFIX}/transport-settings`,
    );
    return response.data.settings as AgentHttpTransportSettings;
  } catch (error) {
    throw handleApiError(error, "load agent transport settings", {
      preserveAuthErrorMessage: true,
    });
  }
}

export async function updateAgentHttpTransportSettings(input: {
  allowHttp: boolean;
  allowedCidrs: string;
}): Promise<AgentHttpTransportSettings> {
  try {
    const response = await agentApi.patch(
      `${AGENT_ADMIN_PREFIX}/transport-settings`,
      input,
    );
    return response.data.settings as AgentHttpTransportSettings;
  } catch (error) {
    throw handleApiError(error, "update agent transport settings", {
      preserveAuthErrorMessage: true,
    });
  }
}

export async function resolveAgentDeviceCode(
`,
  "Agent HTTP UI API",
);

await replaceExact(
  "src/ui/sidebar/AgentIntegrationPanel.tsx",
  `  Pencil,
  RefreshCw,
  ShieldCheck,
`,
  `  Pencil,
  RefreshCw,
  Save,
  ShieldCheck,
`,
  "Agent HTTP save icon",
);

await replaceExact(
  "src/ui/sidebar/AgentIntegrationPanel.tsx",
  `  approveAgentDevice,
  getAgentAdminAccess,
  resolveAgentDeviceCode,
`,
  `  approveAgentDevice,
  getAgentAdminAccess,
  getAgentHttpTransportSettings,
  resolveAgentDeviceCode,
`,
  "Agent HTTP API import 1",
);

await replaceExact(
  "src/ui/sidebar/AgentIntegrationPanel.tsx",
  `  updateAgentDevice,
  type AgentAdminAccess,
`,
  `  updateAgentDevice,
  updateAgentHttpTransportSettings,
  type AgentAdminAccess,
  type AgentHttpTransportSettings,
`,
  "Agent HTTP API import 2",
);

await replaceExact(
  "src/ui/sidebar/AgentIntegrationPanel.tsx",
  `const EMPTY_ACCESS: AgentAdminAccess = { projects: [], devices: [] };
`,
  `const EMPTY_ACCESS: AgentAdminAccess = {
  projects: [],
  devices: [],
  instanceAdmin: false,
};
`,
  "Agent empty access",
);

await replaceExact(
  "src/ui/sidebar/AgentIntegrationPanel.tsx",
  `  const loginCommand = ` + "`node \"${scriptPath}\" auth login --url ${loginUrl}`" + `;
`,
  `  const loginCommand = ` + "`node \"${scriptPath}\" auth login --url ${loginUrl}${insecure ? \" --allow-http\" : \"\"}`" + `;
`,
  "Agent HTTP login command",
);

await replaceExact(
  "src/ui/sidebar/AgentIntegrationPanel.tsx",
  `  const [editingDevice, setEditingDevice] = useState<AgentDevice | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
`,
  `  const [editingDevice, setEditingDevice] = useState<AgentDevice | null>(null);
  const [transportSettings, setTransportSettings] =
    useState<AgentHttpTransportSettings | null>(null);
  const [transportAllowHttp, setTransportAllowHttp] = useState(false);
  const [transportCidrs, setTransportCidrs] = useState("");
  const [stepUpOpen, setStepUpOpen] = useState(false);
`,
  "Agent HTTP state",
);

await replaceExact(
  "src/ui/sidebar/AgentIntegrationPanel.tsx",
  `    try {
      setAccess(await getAgentAdminAccess());
    } catch (error) {
`,
  `    try {
      const nextAccess = await getAgentAdminAccess();
      setAccess(nextAccess);
      if (nextAccess.instanceAdmin) {
        const nextTransport = await getAgentHttpTransportSettings();
        setTransportSettings(nextTransport);
        setTransportAllowHttp(nextTransport.allowHttp);
        setTransportCidrs(nextTransport.allowedCidrs);
      } else {
        setTransportSettings(null);
      }
    } catch (error) {
`,
  "Agent HTTP refresh",
);

await replaceExact(
  "src/ui/sidebar/AgentIntegrationPanel.tsx",
  `  async function saveDevice(input: UpdateAgentDeviceInput) {
`,
  `  async function saveTransportSettings() {
    await runSensitiveAction(
      async () => {
        const saved = await updateAgentHttpTransportSettings({
          allowHttp: transportAllowHttp,
          allowedCidrs: transportCidrs.trim(),
        });
        setTransportSettings(saved);
        setTransportAllowHttp(saved.allowHttp);
        setTransportCidrs(saved.allowedCidrs);
        toast.success(t("agentIntegration.management.transportSaved"));
      },
      t("agentIntegration.management.transportSaveFailed"),
      "transport-settings",
    );
  }

  async function saveDevice(input: UpdateAgentDeviceInput) {
`,
  "Agent HTTP save handler",
);

await replaceExact(
  "src/ui/sidebar/AgentIntegrationPanel.tsx",
  `      <section className="border-y border-border/70 py-3">
        <div className="mb-2 flex items-center gap-2">
`,
  `      {access.instanceAdmin && transportSettings && (
        <section
          data-testid="agent-http-transport-settings"
          className="mb-3 border-y border-border/70 py-3"
        >
          <div className="mb-2 flex items-center gap-2">
            <ShieldCheck className="size-4 text-sky-500" />
            <h3 className="text-xs font-semibold">
              {t("agentIntegration.management.transportTitle")}
            </h3>
          </div>
          <p className="mb-2 text-[10px] leading-4 text-muted-foreground">
            {t("agentIntegration.management.transportDescription")}
          </p>
          <label className="flex items-start gap-2 border border-border/60 bg-background/50 p-2">
            <Checkbox
              checked={transportAllowHttp}
              disabled={busy === "transport-settings"}
              aria-label={t("agentIntegration.management.allowLanHttp")}
              onCheckedChange={(checked) =>
                setTransportAllowHttp(checked === true)
              }
            />
            <span className="min-w-0">
              <span className="block text-[11px] font-semibold">
                {t("agentIntegration.management.allowLanHttp")}
              </span>
              <span className="block text-[9px] leading-4 text-muted-foreground">
                {t("agentIntegration.management.allowLanHttpDescription")}
              </span>
            </span>
          </label>
          <div className="mt-2 space-y-1">
            <Label htmlFor="agent-http-cidrs" className="text-[10px]">
              {t("agentIntegration.management.allowedCidrs")}
            </Label>
            <Input
              id="agent-http-cidrs"
              value={transportCidrs}
              disabled={busy === "transport-settings"}
              placeholder={t(
                "agentIntegration.management.allowedCidrsPlaceholder",
              )}
              onChange={(event) => setTransportCidrs(event.target.value)}
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[9px] text-muted-foreground">
              {t(
                `agentIntegration.management.transportSource.${transportSettings.source}`,
              )}
            </span>
            <Button
              type="button"
              size="sm"
              disabled={
                busy !== null ||
                (transportAllowHttp && transportCidrs.trim().length === 0)
              }
              onClick={() => void saveTransportSettings()}
            >
              {busy === "transport-settings" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Save className="size-3" />
              )}
              {t("agentIntegration.management.saveTransport")}
            </Button>
          </div>
        </section>
      )}

      <section className="border-y border-border/70 py-3">
        <div className="mb-2 flex items-center gap-2">
`,
  "Agent HTTP settings card",
);

await replaceExact(
  "src/ui/sidebar/AgentIntegrationPanel.tsx",
  `      {insecure && (
        <p className="mt-3 text-[10px] text-amber-600">
          {t("agentIntegration.httpsRequiredDescription")}
        </p>
      )}
`,
  `      {insecure && (
        <p className="mt-3 text-[10px] text-amber-600">
          {t(
            transportSettings?.allowHttp
              ? "agentIntegration.lanHttpEnabledDescription"
              : "agentIntegration.httpsRequiredDescription",
          )}
        </p>
      )}
`,
  "Agent HTTP warning",
);

const localeValues = {
  "src/ui/locales/en.json": {
    transportTitle: "Agent transport",
    transportDescription:
      "Allow the signed Agent API over plain HTTP only for explicitly trusted source networks. Changes take effect immediately without recreating the container.",
    allowLanHttp: "Allow trusted LAN HTTP",
    allowLanHttpDescription:
      "HTTPS remains accepted. Plain HTTP is limited to the CIDRs below and still requires device signatures, scopes and replay protection.",
    allowedCidrs: "Allowed source CIDRs",
    allowedCidrsPlaceholder: "192.168.222.0/24,10.0.0.0/8",
    saveTransport: "Save transport policy",
    transportSaved: "Agent transport policy saved",
    transportSaveFailed: "Failed to save Agent transport policy",
    transportSource: {
      database: "Runtime policy saved in CloudSSH",
      environment: "Currently inherited from container environment",
      default: "Default policy: HTTPS and localhost HTTP only",
    },
    lanHttpEnabledDescription:
      "Trusted LAN HTTP is enabled for the configured source CIDRs. The copied login command includes --allow-http.",
  },
  "src/ui/locales/translated/zh_CN.json": {
    transportTitle: "Agent 传输策略",
    transportDescription:
      "只对明确允许的来源网段开放签名 Agent API 的内网明文 HTTP。保存后立即生效，不需要重建容器。",
    allowLanHttp: "允许受信任内网 HTTP",
    allowLanHttpDescription:
      "HTTPS 始终可用；HTTP 仅限下方 CIDR，并继续要求设备签名、权限范围和 nonce 防重放。",
    allowedCidrs: "允许的来源 CIDR",
    allowedCidrsPlaceholder: "192.168.222.0/24,10.0.0.0/8",
    saveTransport: "保存传输策略",
    transportSaved: "Agent 传输策略已保存",
    transportSaveFailed: "保存 Agent 传输策略失败",
    transportSource: {
      database: "当前使用 CloudSSH 内保存的运行时策略",
      environment: "当前继承容器环境变量",
      default: "默认策略：仅 HTTPS 和 localhost HTTP",
    },
    lanHttpEnabledDescription:
      "受信任内网 HTTP 已对配置的来源 CIDR 开启；复制的登录命令会自动包含 --allow-http。",
  },
};
for (const [path, values] of Object.entries(localeValues)) {
  const document = JSON.parse(await text(path));
  Object.assign(document.agentIntegration.management, values);
  document.agentIntegration.lanHttpEnabledDescription =
    values.lanHttpEnabledDescription;
  delete document.agentIntegration.management.lanHttpEnabledDescription;
  await save(path, `${JSON.stringify(document, null, 2)}\n`);
}

await replaceExact(
  "src/backend/panel-runtime/jobs.ts",
  `type LiveJob = {
  job: RuntimeJob;
  controller: AbortController;
  done: Promise<void>;
};
`,
  `type LiveJob = {
  job: RuntimeJob;
  controller: AbortController;
  done: Promise<void>;
};

type RuntimeExecutionOptions = {
  mirror?: boolean;
  client?: Client;
  keepClient?: boolean;
  shared?: boolean;
};
`,
  "runtime execution options",
);

await replaceExact(
  "src/backend/panel-runtime/jobs.ts",
  `        : this.execute(
            owner,
            target,
            job,
            timeout,
            controller,
            sshMode === "mirror",
          )
`,
  `        : this.execute(owner, target, job, timeout, controller, {
            mirror: sshMode === "mirror",
          })
`,
  "runtime execute call",
);

await replaceBetween(
  "src/backend/panel-runtime/jobs.ts",
  `  private async executeSharedTerminal(`,
  `  async read(`,
  `  private async executeSharedTerminal(
    owner: string,
    target: RuntimeTarget,
    job: RuntimeJob,
    timeout: number,
    controller: AbortController,
  ) {
    const sessionId = target.terminalSessionId;
    requireValue(
      sessionId,
      409,
      "SHARED_TERMINAL_REQUIRED",
      "共享所选终端 SSH 需要一个已连接终端",
    );
    const session = sessionManager.getSession(sessionId);
    requireValue(
      session &&
        session.userId === owner &&
        session.hostId === target.hostId &&
        session.isConnected &&
        session.sshConn,
      409,
      "TERMINAL_SESSION_UNAVAILABLE",
      "所选终端的 SSH 连接已断开或不匹配",
    );
    requireValue(
      !session.agentSessionId,
      409,
      "TERMINAL_SESSION_AGENT_CONTROLLED",
      "Agent 持续会话不能作为 Panel Agent 共享连接",
    );

    // Never inject model commands into the human PTY. A dedicated exec channel
    // on the already-authenticated SSH connection shares transport/auth state,
    // while exit, exec, stty, shell traps or malformed input cannot terminate or
    // corrupt the interactive shell shown in the browser.
    await this.execute(owner, target, job, timeout, controller, {
      mirror: true,
      client: session.sshConn,
      keepClient: true,
      shared: true,
    });
  }

  private async execute(
    owner: string,
    target: RuntimeTarget,
    job: RuntimeJob,
    timeout: number,
    controller: AbortController,
    options: RuntimeExecutionOptions = {},
  ) {
    const signal = controller.signal;
    const mirror = options.mirror === true;
    const shared = options.shared === true;
    const keepClient = options.keepClient === true;
    let client: Client | undefined = options.client;
    let stream: ClientChannel | undefined;
    let timedOut = false;
    let outputFailed = false;
    let queue = Promise.resolve();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Command deadline exceeded"));
    }, timeout * 1000);
    const trace = (phase: string, payload: Record<string, unknown> = {}) => {
      if (!mirror) return;
      this.terminalTrace(owner, target, {
        jobId: job.id,
        phase,
        shared,
        ...payload,
      });
    };
    trace("start", { command: job.command, cwd: job.cwd ?? null });

    try {
      await this.authorize(owner, target);
      if (!client) client = await this.connect(owner, target, signal);
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          if (closeTimer) clearTimeout(closeTimer);
          signal.removeEventListener("abort", abort);
          client?.removeListener("error", failed);
          client?.removeListener("close", closed);
          stream?.removeListener("error", failed);
          stream?.stderr.removeListener("error", failed);
          if (error) reject(error);
          else resolve();
        };
        const failed = (error: Error) => finish(error);
        const closed = () =>
          finish(
            new Error(
              shared
                ? "共享 SSH 连接已断开；交互终端状态需要重新确认"
                : "SSH disconnected; remote execution state unknown",
            ),
          );
        const abort = () => {
          if (settled || closeTimer) return;
          try {
            stream?.signal("TERM");
          } catch {
            /* Remote server may not support signals. */
          }
          closeTimer = setTimeout(() => {
            try {
              stream?.close();
              if (!keepClient) client?.destroy();
            } catch {
              /* The command channel may already be closed. */
            }
            finish();
          }, 1500);
        };
        client!.once("error", failed);
        client!.once("close", closed);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        const command = job.cwd
          ? `cd -- ${shellQuote(job.cwd)} && ${job.command}`
          : job.command;
        client!.exec(command, { pty: false }, (error, channel) => {
          if (error) {
            finish(error);
            return;
          }
          if (settled) {
            channel.close();
            return;
          }
          stream = channel;
          job.status = "running";
          let pendingBytes = 0;
          const receive = (kind: "stdout" | "stderr", data: Buffer) => {
            if (signal.aborted) return;
            trace(kind, { data: data.toString("utf8") });
            pendingBytes += data.length;
            if (pendingBytes > 8 * 1024 * 1024) {
              outputFailed = true;
              controller.abort(
                new Error("Output write backlog exceeded memory safety window"),
              );
              return;
            }
            channel.pause();
            channel.stderr.pause();
            queue = queue
              .then(() => this.spool.append(job, kind, Buffer.from(data)))
              .catch((appendError) => {
                outputFailed = true;
                job.error =
                  appendError instanceof Error
                    ? appendError.message
                    : String(appendError);
                controller.abort(appendError);
              })
              .finally(() => {
                pendingBytes -= data.length;
                if (!signal.aborted) {
                  channel.resume();
                  channel.stderr.resume();
                }
              });
          };
          channel.on("data", (data: Buffer) => receive("stdout", data));
          channel.stderr.on("data", (data: Buffer) =>
            receive("stderr", data),
          );
          channel.on("error", failed);
          channel.stderr.on("error", failed);
          channel.on(
            "exit",
            (code: number | null, exitSignal: string | null) => {
              job.exitCode = typeof code === "number" ? code : null;
              job.signal = exitSignal || null;
            },
          );
          channel.once("close", () => finish());
          channel.end();
          if (signal.aborted) abort();
        });
      });
      await queue;
      if (signal.aborted) {
        job.status = outputFailed
          ? "output_limit"
          : timedOut
            ? "timed_out"
            : "cancelled";
        job.error ||=
          shared
            ? "已请求终止共享 SSH 命令通道；左侧交互终端未被关闭"
            : "已请求终止独立任务；远端可能忽略信号，不能确认所有子进程已结束";
      } else if (job.exitCode === null) {
        job.status = "interrupted";
        job.error = "SSH 未返回退出状态，结果未知";
      } else {
        job.status = job.exitCode === 0 ? "completed" : "failed";
      }
    } catch (error) {
      await queue;
      job.status = outputFailed
        ? "output_limit"
        : timedOut
          ? "timed_out"
          : signal.aborted
            ? "cancelled"
            : "interrupted";
      job.error = redactEvidence(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 800);
    } finally {
      clearTimeout(timer);
      try {
        stream?.close();
        if (!keepClient) client?.end();
      } catch {
        /* Only the command channel is closed for shared connections. */
      }
      trace("end", {
        status: job.status,
        exitCode: job.exitCode,
        error: job.error,
      });
    }
  }
`,
  "safe shared SSH execution",
);

const jobsTestPath = "src/backend/panel-runtime/jobs.test.ts";
{
  const current = await text(jobsTestPath);
  const start = current.indexOf('describe("shared terminal execution"');
  if (start < 0) throw new Error("shared terminal test block not found");
  const replacement = `describe("shared terminal execution", () => {
  function prepareShared(
    store: RuntimeStore,
    run: RuntimeRun,
    command = "pwd",
  ) {
    const sessionId = "terminal-session-123";
    terminalSessions.push(sessionId);
    sessionManager.createSession(
      "alice",
      42,
      "test",
      120,
      40,
      undefined,
      false,
      { sessionId },
    );
    const session = sessionManager.getSession(sessionId)!;
    const interactive = new Channel();
    const interactiveWrite = vi.spyOn(interactive, "write");
    const connection = new Connection();
    connection.end = vi.fn();
    connection.destroy = vi.fn();
    connection.exec.mockImplementation(
      (
        _command: string,
        _options: unknown,
        callback: (error: Error | null, channel: Channel) => void,
      ) => {
        callback(null, connection.channel);
        setTimeout(() => {
          connection.channel.push(Buffer.from("shared output"));
          connection.channel.emit("exit", 0, null);
          connection.channel.emit("close");
        }, 2);
      },
    );
    session.isConnected = true;
    session.sshConn = connection as unknown as Client;
    session.sshStream = interactive as unknown as ClientChannel;
    run.options = { sshMode: "shared-terminal" };
    run.targets = [
      {
        targetId: "target",
        hostId: 42,
        hostName: "test",
        terminalSessionId: sessionId,
      },
    ];
    return { session, connection, interactiveWrite, command };
  }

  it("opens a separate exec channel on the selected SSH connection without writing into the human PTY", async () => {
    const { store, run, call } = await fixture();
    const shared = prepareShared(store, run);
    await store.saveRun("alice", run);
    const connect = vi.fn();
    const jobs = new RuntimeJobs(store, async () => {}, await spool(), connect);
    const started = await jobs.start(
      "alice",
      run,
      call,
      new AbortController().signal,
    );

    expect(connect).not.toHaveBeenCalled();
    expect(shared.connection.exec).toHaveBeenCalledWith(
      "pwd",
      { pty: false },
      expect.any(Function),
    );
    expect(shared.interactiveWrite).not.toHaveBeenCalled();
    expect(shared.connection.end).not.toHaveBeenCalled();
    expect(shared.connection.destroy).not.toHaveBeenCalled();

    const output = await jobs.read(
      "alice",
      run,
      started.id,
      { waitSeconds: 2 },
      2048,
      new AbortController().signal,
    );
    expect(output).toMatchObject({
      status: "completed",
      exitCode: 0,
      stdout: expect.stringContaining("shared output"),
    });
    expect(shared.session.isConnected).toBe(true);
    expect(shared.session.agentRuntimeLeaseId).toBeNull();
  });

  it("keeps the interactive shell alive even when the model command is exit or exec", async () => {
    const { store, run, call } = await fixture();
    call.arguments.command = "exit";
    run.pending = [call];
    const shared = prepareShared(store, run, "exit");
    await store.saveRun("alice", run);
    const jobs = new RuntimeJobs(store, async () => {}, await spool(), vi.fn());

    const started = await jobs.start(
      "alice",
      run,
      call,
      new AbortController().signal,
    );
    const output = await jobs.read(
      "alice",
      run,
      started.id,
      { waitSeconds: 2 },
      2048,
      new AbortController().signal,
    );

    expect(output.status).toBe("completed");
    expect(shared.connection.exec).toHaveBeenCalledWith(
      "exit",
      { pty: false },
      expect.any(Function),
    );
    expect(shared.interactiveWrite).not.toHaveBeenCalled();
    expect(shared.connection.end).not.toHaveBeenCalled();
    expect(shared.session.isConnected).toBe(true);
  });
});
`;
  await save(jobsTestPath, current.slice(0, start) + replacement);
}

await save(
  "src/ui/features/terminal/agent-trace.ts",
  `export type AgentTraceStream = "stdout" | "stderr";

export type AgentTraceChunk = {
  stream: AgentTraceStream;
  data: string;
};

export type AgentTraceBuffer = {
  command: string;
  cwd: string | null;
  shared: boolean;
  chunks: AgentTraceChunk[];
  chars: number;
  truncated: boolean;
};

const OSC_SEQUENCE = /\\x1b\\][^\\x07]*(?:\\x07|\\x1b\\\\)/g;
const ESCAPE_SEQUENCE = /\\x1b(?:[@-Z\\\\-_]|\\[[0-9;?>=!]*[@-~])/g;
const TRACE_LIMIT = 128 * 1024;

export function sanitizeAgentTraceText(value: string): string {
  return value
    .replace(OSC_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(/\\r\\n?/g, "\\n")
    .replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/g, "");
}

export function createAgentTraceBuffer(input: {
  command: unknown;
  cwd?: unknown;
  shared?: unknown;
}): AgentTraceBuffer {
  return {
    command: sanitizeAgentTraceText(String(input.command ?? "")).trim(),
    cwd:
      typeof input.cwd === "string" && input.cwd.trim()
        ? sanitizeAgentTraceText(input.cwd).trim()
        : null,
    shared: input.shared === true,
    chunks: [],
    chars: 0,
    truncated: false,
  };
}

export function appendAgentTraceChunk(
  buffer: AgentTraceBuffer,
  stream: AgentTraceStream,
  value: unknown,
  limit = TRACE_LIMIT,
): void {
  if (buffer.truncated) return;
  const clean = sanitizeAgentTraceText(String(value ?? ""));
  const remaining = Math.max(0, limit - buffer.chars);
  const accepted = clean.slice(0, remaining);
  if (accepted) {
    const previous = buffer.chunks.at(-1);
    if (previous?.stream === stream) previous.data += accepted;
    else buffer.chunks.push({ stream, data: accepted });
    buffer.chars += accepted.length;
  }
  if (accepted.length < clean.length || buffer.chars >= limit) {
    buffer.truncated = true;
  }
}

function prefixedLines(prefix: string, value: string): string[] {
  const lines = value.split("\\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => `${prefix}${line}`);
}

export function formatAgentTraceBlock(
  buffer: AgentTraceBuffer,
  input: { status?: unknown; exitCode?: unknown; error?: unknown },
): string {
  const status = sanitizeAgentTraceText(String(input.status ?? "done")).trim();
  const exitCode =
    typeof input.exitCode === "number" && Number.isSafeInteger(input.exitCode)
      ? ` · exit ${input.exitCode}`
      : "";
  const mode = buffer.shared ? "shared connection" : "isolated mirror";
  const lines = [
    `\\u001b[35m┌─ Agent · ${mode}\\u001b[0m`,
    ...prefixedLines("\\u001b[35m│\\u001b[0m $ ", buffer.command || "(empty command)"),
  ];
  if (buffer.cwd) {
    lines.push(`\\u001b[35m│\\u001b[0m cwd: ${buffer.cwd}`);
  }
  for (const chunk of buffer.chunks) {
    const prefix =
      chunk.stream === "stderr"
        ? "\\u001b[35m│\\u001b[0m [stderr] "
        : "\\u001b[35m│\\u001b[0m ";
    lines.push(...prefixedLines(prefix, chunk.data));
  }
  if (buffer.chunks.length === 0) {
    lines.push("\\u001b[35m│\\u001b[0m (no output)");
  }
  if (buffer.truncated) {
    lines.push("\\u001b[35m│\\u001b[0m … terminal mirror truncated; full output remains in Agent logs");
  }
  const error = sanitizeAgentTraceText(String(input.error ?? "")).trim();
  if (error) lines.push(`\\u001b[35m│\\u001b[0m error: ${error}`);
  lines.push(`\\u001b[35m└─ Agent\\u001b[0m ${status}${exitCode}`);
  return `\\r\\n${lines.join("\\r\\n")}\\r\\n`;
}
`,
);

await replaceExact(
  "src/ui/features/terminal/Terminal.tsx",
  `import type {
  TerminalHandle,
  TerminalHostConfig,
  TerminalSessionPersistenceState,
} from "./terminal-types.ts";
`,
  `import type {
  TerminalHandle,
  TerminalHostConfig,
  TerminalSessionPersistenceState,
} from "./terminal-types.ts";
import {
  appendAgentTraceChunk,
  createAgentTraceBuffer,
  formatAgentTraceBlock,
  type AgentTraceBuffer,
} from "./agent-trace.ts";
`,
  "terminal agent trace import",
);

await replaceExact(
  "src/ui/features/terminal/Terminal.tsx",
  `    const recentOutputRef = useRef("");
    const config = {
`,
  `    const recentOutputRef = useRef("");
    const agentTraceBuffersRef = useRef<Map<string, AgentTraceBuffer>>(
      new Map(),
    );
    const config = {
`,
  "terminal trace buffer ref",
);

await replaceExact(
  "src/ui/features/terminal/Terminal.tsx",
  `        panelAgentInputBlockedRef.current = false;
        syncTerminalInputState();
        alternateScreenModeRef.current = false;
`,
  `        panelAgentInputBlockedRef.current = false;
        syncTerminalInputState();
        alternateScreenModeRef.current = false;
        agentTraceBuffersRef.current.clear();
`,
  "clear terminal trace buffers",
);

await replaceBetween(
  "src/ui/features/terminal/Terminal.tsx",
  `          } else if (msg.type === "agentTrace") {`,
  `          } else if (msg.type === "agentControlState") {`,
  `          } else if (msg.type === "agentTrace") {
            const phase = String(msg.phase || "");
            if (phase === "conceal") {
              terminal.write("\\u001b[8m");
            } else if (phase === "reveal") {
              terminal.write("\\u001b[28m");
            } else {
              const jobId =
                typeof msg.jobId === "string" && msg.jobId
                  ? msg.jobId
                  : "legacy-agent-trace";
              if (phase === "start") {
                agentTraceBuffersRef.current.set(
                  jobId,
                  createAgentTraceBuffer({
                    command: msg.command,
                    cwd: msg.cwd,
                    shared: msg.shared,
                  }),
                );
              } else if (phase === "stdout" || phase === "stderr") {
                const buffer =
                  agentTraceBuffersRef.current.get(jobId) ??
                  createAgentTraceBuffer({
                    command: "(command started before this terminal attached)",
                    shared: msg.shared,
                  });
                appendAgentTraceChunk(buffer, phase, msg.data);
                agentTraceBuffersRef.current.set(jobId, buffer);
              } else if (phase === "end") {
                const buffer =
                  agentTraceBuffersRef.current.get(jobId) ??
                  createAgentTraceBuffer({
                    command: "(command details unavailable)",
                    shared: msg.shared,
                  });
                terminal.write(
                  formatAgentTraceBlock(buffer, {
                    status: msg.status,
                    exitCode: msg.exitCode,
                    error: msg.error,
                  }),
                );
                agentTraceBuffersRef.current.delete(jobId);
              }
            }
`,
  "atomic terminal Agent trace",
);

await save(
  "src/ui/tests/features/terminal/agent-trace.test.ts",
  `import { describe, expect, it } from "vitest";
import {
  appendAgentTraceChunk,
  createAgentTraceBuffer,
  formatAgentTraceBlock,
} from "@/features/terminal/agent-trace";

describe("Agent terminal trace formatting", () => {
  it("renders interleaved chunks as one readable sanitized block", () => {
    const buffer = createAgentTraceBuffer({
      command: "printf 'ok'\\nwhoami",
      cwd: "/srv/app",
      shared: false,
    });
    appendAgentTraceChunk(buffer, "stdout", "first\\n");
    appendAgentTraceChunk(buffer, "stderr", "\\u001b[31mwarning\\u001b[0m\\n");
    appendAgentTraceChunk(buffer, "stdout", "last\\r\\n");

    const output = formatAgentTraceBlock(buffer, {
      status: "completed",
      exitCode: 0,
    });

    expect(output).toContain("$ printf 'ok'");
    expect(output).toContain("whoami");
    expect(output).toContain("first");
    expect(output).toContain("[stderr] warning");
    expect(output).toContain("last");
    expect(output).toContain("completed · exit 0");
    expect(output).not.toContain("\\u001b[31m");
  });

  it("bounds mirrored output while keeping the full job log separate", () => {
    const buffer = createAgentTraceBuffer({ command: "yes" });
    appendAgentTraceChunk(buffer, "stdout", "x".repeat(64), 16);
    expect(buffer.truncated).toBe(true);
    expect(buffer.chars).toBe(16);
    expect(
      formatAgentTraceBlock(buffer, { status: "completed", exitCode: 0 }),
    ).toContain("terminal mirror truncated");
  });
});
`,
);

await replaceExact(
  "src/ui/sidebar/PanelAgentPanel.tsx",
  `              默认独立执行并把过程同步显示到左侧终端；共享模式会使用同一个
              PTY，并在 Agent 命令执行期间临时锁定人工输入。
`,
  `              默认独立执行并把结果整理成完整区块同步到左侧终端；共享模式复用
              已连接的 SSH 连接，但使用独立命令通道，不再向人工 shell 注入指令。
`,
  "SSH mode description",
);

await replaceExact(
  "src/ui/sidebar/PanelAgentPanel.tsx",
  `                  hint: "后端独立 SSH 执行；左侧只显示命令和输出，不会重复执行。",
`,
  `                  hint: "后端独立 SSH 执行；完成后按顺序显示整块命令、stdout 和 stderr。",
`,
  "mirror mode hint",
);

await replaceExact(
  "src/ui/sidebar/PanelAgentPanel.tsx",
  `                  label: "共享所选终端 SSH",
                  hint: "与一个已连接终端共享同一 shell、cwd 和环境变量。",
`,
  `                  label: "共享所选终端 SSH 连接",
                  hint: "复用已认证 SSH 连接并打开安全命令通道；exit、exec、stty 等不会再关闭或破坏左侧 shell。需要目录时由 Agent 显式传递 cwd。",
`,
  "shared mode hint",
);

await save(
  "src/backend/agent/transport-settings.test.ts",
  `import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  readAgentHttpTransportSettings,
  resolveAgentHttpTransportEnvironment,
  writeAgentHttpTransportSettings,
} from "./transport-settings.js";

function database() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

describe("Agent HTTP transport settings", () => {
  it("uses environment defaults until an administrator saves a runtime override", () => {
    const db = database();
    try {
      expect(
        readAgentHttpTransportSettings(db, {
          CLOUDSSH_AGENT_ALLOW_HTTP: "true",
          CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS: "192.168.0.0/16",
        }),
      ).toEqual({
        allowHttp: true,
        allowedCidrs: "192.168.0.0/16",
        source: "environment",
      });

      const saved = writeAgentHttpTransportSettings(db, {
        allowHttp: true,
        allowedCidrs: "192.168.222.10/24, 10.0.0.0/8",
      });
      expect(saved).toEqual({
        allowHttp: true,
        allowedCidrs: "192.168.222.10/24,10.0.0.0/8",
        source: "database",
      });
      expect(
        resolveAgentHttpTransportEnvironment(db, {
          CLOUDSSH_AGENT_ALLOW_HTTP: "false",
        }),
      ).toMatchObject({
        CLOUDSSH_AGENT_ALLOW_HTTP: "true",
        CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS:
          "192.168.222.10/24,10.0.0.0/8",
      });
    } finally {
      db.close();
    }
  });

  it("refuses an enabled HTTP policy without a valid source CIDR", () => {
    const db = database();
    try {
      expect(() =>
        writeAgentHttpTransportSettings(db, {
          allowHttp: true,
          allowedCidrs: "",
        }),
      ).toThrow("必须至少配置一个来源 CIDR");
      expect(() =>
        writeAgentHttpTransportSettings(db, {
          allowHttp: true,
          allowedCidrs: "not-a-network",
        }),
      ).toThrow("有效的 IPv4/IPv6 CIDR");
    } finally {
      db.close();
    }
  });
});
`,
);

await replaceExact(
  "src/backend/tests/utils/trust-loopback-proxy.test.ts",
  `  isAddressAllowedByCidrs,
  isAdministrativeTransportAllowed,
`,
  `  isAddressAllowedByCidrs,
  isAdministrativeTransportAllowed,
  normalizeAgentHttpAllowedCidrs,
`,
  "CIDR test import",
);

await replaceExact(
  "src/backend/tests/utils/trust-loopback-proxy.test.ts",
  `  it("正确识别 IPv4、IPv4-mapped IPv6 和 IPv6 CIDR", () => {
`,
  `  it("规范化并拒绝无效的 Agent HTTP CIDR 列表", () => {
    expect(
      normalizeAgentHttpAllowedCidrs(
        "192.168.222.0/24, 10.0.0.5,192.168.222.0/24",
      ),
    ).toEqual(["192.168.222.0/24", "10.0.0.5/32"]);
    expect(normalizeAgentHttpAllowedCidrs("192.168.0.0/99")).toBeNull();
    expect(normalizeAgentHttpAllowedCidrs("invalid")).toBeNull();
  });

  it("正确识别 IPv4、IPv4-mapped IPv6 和 IPv6 CIDR", () => {
`,
  "CIDR normalizer test",
);

await replaceExact(
  "src/ui/tests/sidebar/AgentIntegrationPanel.test.tsx",
  `  getAgentAdminAccess: vi.fn(),
  resolveAgentDeviceCode: vi.fn(),
`,
  `  getAgentAdminAccess: vi.fn(),
  getAgentHttpTransportSettings: vi.fn(),
  updateAgentHttpTransportSettings: vi.fn(),
  resolveAgentDeviceCode: vi.fn(),
`,
  "Agent transport API mocks",
);

await replaceExact(
  "src/ui/tests/sidebar/AgentIntegrationPanel.test.tsx",
  `  agentApi.getAgentAdminAccess.mockResolvedValue({
    projects: [{ id: "project-1", name: "生产项目" }],
`,
  `  agentApi.getAgentAdminAccess.mockResolvedValue({
    projects: [{ id: "project-1", name: "生产项目" }],
    instanceAdmin: true,
`,
  "Agent admin fixture flag",
);

await replaceExact(
  "src/ui/tests/sidebar/AgentIntegrationPanel.test.tsx",
  `  agentApi.resolveAgentDeviceCode.mockResolvedValue({
`,
  `  agentApi.getAgentHttpTransportSettings.mockResolvedValue({
    allowHttp: false,
    allowedCidrs: "",
    source: "default",
  });
  agentApi.updateAgentHttpTransportSettings.mockResolvedValue({
    allowHttp: true,
    allowedCidrs: "192.168.222.0/24",
    source: "database",
  });
  agentApi.resolveAgentDeviceCode.mockResolvedValue({
`,
  "Agent transport fixture",
);

await replaceExact(
  "src/ui/tests/sidebar/AgentIntegrationPanel.test.tsx",
  `  it("默认收起低频 Agent 提示词并允许手动展开", async () => {
`,
  `  it("实例管理员可以在界面启用内网 HTTP 并复制带 allow-http 的登录命令", async () => {
    render(
      <AgentIntegrationPanel platformUrl="http://192.168.222.126:8080" />,
    );

    expect(document.body.textContent).toContain(
      "auth login --url http://192.168.222.126:8080 --allow-http",
    );
    const allow = await screen.findByLabelText(
      "agentIntegration.management.allowLanHttp",
    );
    fireEvent.click(allow);
    fireEvent.change(
      screen.getByLabelText("agentIntegration.management.allowedCidrs"),
      { target: { value: "192.168.222.0/24" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "agentIntegration.management.saveTransport",
      }),
    );

    await waitFor(() =>
      expect(agentApi.updateAgentHttpTransportSettings).toHaveBeenCalledWith({
        allowHttp: true,
        allowedCidrs: "192.168.222.0/24",
      }),
    );
  });

  it("默认收起低频 Agent 提示词并允许手动展开", async () => {
`,
  "Agent transport UI test",
);

await replaceExact(
  "docs/CLOUDSSH.md",
  `Docker Compose 对应配置：

` + "```sh\n" + `CLOUDSSH_AGENT_ALLOW_HTTP=true \\
CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS=192.168.0.0/16 \\
docker compose -f docker/docker-compose.cloudssh.yml up -d
` + "```\n",
  `实例管理员也可以在网页“Agent 接入 → Agent 传输策略”中启用内网 HTTP 并填写
CIDR；该设置保存到 CloudSSH 数据库并立即生效，优先于容器环境变量，不需要重建
容器。环境变量仍作为首次部署和无人值守部署的默认值：

` + "```sh\n" + `CLOUDSSH_AGENT_ALLOW_HTTP=true \\
CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS=192.168.0.0/16 \\
docker compose -f docker/docker-compose.cloudssh.yml up -d
` + "```\n",
  "Agent HTTP docs",
);

await replaceExact(
  "skills/cloudssh-agent/SKILL.md",
  `- **受信任内网**：服务端管理员必须同时设置 ` + "`CLOUDSSH_AGENT_ALLOW_HTTP=true`" + `
  和 ` + "`CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS`" + `，客户端首次登录再显式使用
`,
  `- **受信任内网**：服务端管理员可以在网页“Agent 接入 → Agent 传输策略”中
  开启 HTTP 并配置来源 CIDR，也可以通过 ` + "`CLOUDSSH_AGENT_ALLOW_HTTP=true`" + `
  和 ` + "`CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS`" + ` 提供部署默认值；客户端首次登录再显式使用
`,
  "Skill HTTP settings docs",
);

for (const path of [
  "package.json",
  "package-lock.json",
  "docker/docker-compose.cloudssh.yml",
  "scripts/cloudssh-verify-restore.sh",
  "docs/CLOUDSSH-UPDATES.md",
]) {
  await bump(path);
}

{
  const path = "docs/PANEL-AGENT-RUNTIME.md";
  const current = await text(path);
  const next = current.replace(
    /^# Panel Agent runtime - .*$/m,
    `# Panel Agent runtime - 2.6.0-cloudssh.69`,
  );
  if (next === current) throw new Error("runtime guide header not found");
  await save(
    path,
    next.replace(
      /\n## /,
      `\n## .69 safe shared SSH and ordered terminal traces\n\nShared-terminal mode no longer writes model-generated shell text into the human PTY. It opens a non-PTY exec channel on the already-authenticated SSH connection, so shell builtins such as exit/exec, terminal mode changes, malformed input and partially typed human commands cannot terminate or corrupt the browser terminal. Mirrored output is buffered per job, sanitized, bounded and rendered once as an ordered command/stdout/stderr block.\n\nThe Agent integration page now lets instance administrators enable trusted-LAN HTTP and edit allowed source CIDRs at runtime. The persisted policy takes effect immediately and overrides deployment environment defaults while retaining device signatures, scopes, nonce replay protection and audit requirements.\n\n## `,
    ),
  );
}

await replaceExact(
  "RELEASE_NOTES.md",
  `<!-- UPDATE_LOG -->

`,
  `<!-- UPDATE_LOG -->

- Added an instance-admin Agent transport policy panel for trusted-LAN HTTP and allowed source CIDRs. Saved policy changes apply immediately and override container defaults without a restart.
- Reworked shared-terminal execution to reuse the selected SSH connection through a separate command channel instead of injecting commands into the human PTY.
- Replaced raw chunk-by-chunk terminal mirroring with bounded, sanitized, ordered Agent command/stdout/stderr result blocks.
`,
  "release notes updates",
);

await replaceExact(
  "RELEASE_NOTES.md",
  `<!-- BUG_FIXES -->

`,
  `<!-- BUG_FIXES -->

- Fixed shared-terminal Agent commands intermittently closing or corrupting the live terminal when commands used exit, exec, stty, shell traps, interactive control sequences, or collided with partially typed human input.
- Fixed independent-mode terminal mirroring interleaving stdout/stderr chunks with the prompt and displaying control sequences out of order.
`,
  "release notes fixes",
);

console.log("CloudSSH .69 patch applied");
