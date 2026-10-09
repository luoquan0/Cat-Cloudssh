import express from "express";
import type { AuthenticatedRequest } from "../../types/index.js";
import { getRequestMeta } from "../utils/audit-logger.js";
import {
  isAdministrativeTransportAllowed,
  isAgentTransportAllowed,
} from "../utils/trust-loopback-proxy.js";
import {
  requireRecentMfa,
  type AgentDeviceAdminDependencies,
} from "./device-admin.js";
import { AgentHttpPolicyStore, isPrivateAgentAddress } from "./http-policy.js";

export function createAgentHttpPolicyRouter(
  deps: AgentDeviceAdminDependencies,
  store: AgentHttpPolicyStore,
) {
  const router = express.Router();
  router.use(deps.authenticate);
  router.use(async (req, res, next) => {
    try {
      const auth = req as AuthenticatedRequest;
      if (auth.apiKeyId || !auth.sessionId || auth.pendingTOTP)
        return res
          .status(401)
          .json({
            code: "INTERACTIVE_SESSION_REQUIRED",
            error: "只允许完成登录的管理员网页会话",
          });
      if (!(await deps.isInstanceAdmin(auth.userId)))
        return res
          .status(403)
          .json({
            code: "ADMIN_REQUIRED",
            error: "只允许实例管理员修改传输策略",
          });
      res.setHeader("Cache-Control", "private, no-store");
      next();
    } catch (error) {
      next(error);
    }
  });
  const bootstrapAllowed = (req: express.Request) =>
    isAdministrativeTransportAllowed(req, "production", {
      ...process.env,
      CLOUDSSH_AGENT_ALLOW_HTTP: "false",
      CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS: "",
    }) || isPrivateAgentAddress(req.ip);
  router.get("/", (req, res) => {
    res.json({
      ...store.snapshot(),
      sourceAddress: req.ip || null,
      currentRequestAllowed: isAgentTransportAllowed(req),
      canConfigure: bootstrapAllowed(req),
    });
  });
  router.post("/", async (req, res, next) => {
    try {
      if (!bootstrapAllowed(req))
        return res
          .status(426)
          .json({
            code: "HTTPS_REQUIRED",
            error: "公网管理必须使用 HTTPS；内网首次开启需从真实内网来源访问",
          });
      // Browser Origin is mandatory for this security-policy mutation. The
      // proxy must preserve Host; arbitrary forwarded headers are not trusted.
      const origin = req.get("origin");
      let sameOrigin = false;
      try {
        const parsed = new URL(origin || "");
        sameOrigin =
          parsed.host === req.get("host") &&
          parsed.protocol === `${req.protocol}:`;
      } catch {
        /* reject */
      }
      if (!sameOrigin)
        return res
          .status(403)
          .json({
            code: "ORIGIN_REQUIRED",
            error: "请从 CloudSSH 同源管理页面保存配置",
          });
      if (!requireRecentMfa(deps, req, res)) return;
      if (!deps.audit) throw new Error("Audit persistence unavailable");
      const auth = req as AuthenticatedRequest;
      await store.update(req.body, (policy) =>
        deps.audit!({
          userId: auth.userId,
          username: auth.user?.username || auth.userId,
          action: "agent_http_policy_change_intent",
          resourceType: "agent_transport_policy",
          details: JSON.stringify({ before: store.snapshot(), after: policy }),
          ...getRequestMeta(req),
          success: true,
        }),
      );
      res.json({
        ...store.snapshot(),
        sourceAddress: req.ip || null,
        currentRequestAllowed: isAgentTransportAllowed(req),
        canConfigure: bootstrapAllowed(req),
      });
    } catch (error) {
      next(error);
    }
  });
  router.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const v = error as { status?: number; code?: string; message?: string };
      res
        .status(v.status || 500)
        .json({
          code: v.code || "HTTP_POLICY_SAVE_FAILED",
          error: v.status
            ? v.message
            : "配置保存或审计失败，未启用新的 HTTP 授权",
        });
    },
  );
  return router;
}
