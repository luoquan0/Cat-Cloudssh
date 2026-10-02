import express, {
  type Request,
  type Response,
  type RequestHandler,
  type NextFunction,
} from "express";
import type { AuthenticatedRequest } from "../../types/index.js";
import type { RuntimeTarget } from "../../types/panel-runtime.js";
import type { PanelRuntime } from "./runtime.js";
import type { RuntimeModelConfig } from "./model.js";
import { RuntimeError, requireValue, validId } from "./store.js";
import { naturalNumber, parseStartRuntime } from "./input.js";

type Services = {
  runtime: () => PanelRuntime;
  config: () => Promise<RuntimeModelConfig>;
  session: (owner: string, sessionId: string) => Promise<void>;
  target: (owner: string, target: RuntimeTarget) => Promise<void>;
};
export function createRuntimeRouter(
  authenticate: RequestHandler,
  services: Services,
) {
  const router = express.Router();
  router.use(authenticate);
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (
      req.method !== "GET" &&
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      res
        .status(403)
        .json({ error: "跨站写请求被拒绝", code: "CROSS_SITE_REQUEST" });
      return;
    }
    next();
  });
  const identity = (req: Request) => {
    const auth = req as AuthenticatedRequest;
    requireValue(
      auth.userId &&
        auth.sessionId &&
        !auth.pendingTOTP &&
        !auth.actingAdminUserId,
      401,
      "BROWSER_SESSION_REQUIRED",
      "请使用本人已完成验证的网页登录会话操作 Agent",
    );
    return { owner: auth.userId, sessionId: auth.sessionId };
  };
  const checkedId = (value: unknown) => {
    requireValue(validId(value), 400, "INVALID_ID", "记录标识无效");
    return value;
  };
  const route =
    (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req, res, next) => {
      void handler(req, res).catch(next);
    };
  const capability =
    (owner: string, sessionId: string, targets: RuntimeTarget[]) =>
    async () => {
      await services.session(owner, sessionId);
      const config = await services.config();
      requireValue(config.enabled, 403, "AGENT_DISABLED", "管理员已关闭 Agent");
      requireValue(
        config.multiServerEnabled || targets.length <= 1,
        403,
        "MULTI_SERVER_DISABLED",
        "多服务器任务未启用",
      );
      requireValue(
        targets.length <= config.maxTargets,
        400,
        "TARGET_LIMIT",
        "选择的服务器超过配置数量",
      );
      for (const target of targets) await services.target(owner, target);
    };
  router.post(
    "/runs",
    route(async (req, res) => {
      const { owner, sessionId } = identity(req);
      requireValue(
        Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8") <=
          16 * 1024 * 1024,
        413,
        "REQUEST_TOO_LARGE",
        "单次请求过大，请减少附件",
      );
      const input = parseStartRuntime(req.body);
      const check = capability(owner, sessionId, input.targets);
      await check();
      const config = await services.config();
      requireValue(
        config.baseUrl &&
          config.apiKey &&
          (input.options.model || config.model),
        409,
        "MODEL_NOT_CONFIGURED",
        "请先配置模型接口",
      );
      const runtime = services.runtime();
      const run = await runtime.start(owner, input, check);
      res.status(202).json({ run });
    }),
  );
  router.get(
    "/active",
    route(async (req, res) => {
      const { owner, sessionId } = identity(req);
      await services.session(owner, sessionId);
      const runtime = services.runtime();
      await runtime.initialize();
      res.json({ run: runtime.store.active(owner) });
    }),
  );
  router.get(
    "/threads",
    route(async (req, res) => {
      const { owner, sessionId } = identity(req);
      await services.session(owner, sessionId);
      const runtime = services.runtime();
      await runtime.initialize();
      const offset = naturalNumber(req.query.offset);
      const threads = runtime.store.list(owner, offset);
      res.json({
        threads,
        nextOffset: threads.length === 50 ? offset + 50 : null,
      });
    }),
  );
  router.get(
    "/threads/:id",
    route(async (req, res) => {
      const { owner, sessionId } = identity(req);
      await services.session(owner, sessionId);
      const runtime = services.runtime();
      await runtime.initialize();
      const snapshot = runtime.store.snapshot(
        owner,
        checkedId(req.params.id),
        req.query.after === undefined
          ? undefined
          : naturalNumber(req.query.after),
      );
      // The UI needs attachment metadata, not repeated multi-megabyte image data.
      snapshot.messages = snapshot.messages.map((message) => ({
        ...message,
        attachments: message.attachments?.map(
          ({ dataUrl: _dataUrl, text: _text, ...metadata }) => metadata,
        ),
      }));
      res.json(snapshot);
    }),
  );
  router.delete(
    "/threads/:id",
    route(async (req, res) => {
      const { owner, sessionId } = identity(req);
      await services.session(owner, sessionId);
      const runtime = services.runtime();
      await runtime.initialize();
      const ids = await runtime.store.remove(owner, checkedId(req.params.id));
      await runtime.jobs.spool.remove(ids);
      res.json({ deleted: true });
    }),
  );
  router.get(
    "/runs/:id",
    route(async (req, res) => {
      const { owner, sessionId } = identity(req);
      await services.session(owner, sessionId);
      const runtime = services.runtime();
      await runtime.initialize();
      res.json({ run: runtime.store.run(owner, checkedId(req.params.id)) });
    }),
  );
  router.post(
    "/runs/:id/cancel",
    route(async (req, res) => {
      const { owner, sessionId } = identity(req);
      await services.session(owner, sessionId);
      const runtime = services.runtime();
      await runtime.initialize();
      res.json({ run: await runtime.cancel(owner, checkedId(req.params.id)) });
    }),
  );
  router.post(
    "/runs/:id/resume",
    route(async (req, res) => {
      const { owner, sessionId } = identity(req);
      const runtime = services.runtime();
      await runtime.initialize();
      const run = runtime.store.run(owner, checkedId(req.params.id));
      res.json({
        run: await runtime.resume(
          owner,
          run.id,
          capability(owner, sessionId, run.targets),
        ),
      });
    }),
  );
  router.post(
    "/runs/:id/approval",
    route(async (req, res) => {
      const { owner, sessionId } = identity(req);
      requireValue(
        typeof req.body?.approved === "boolean" &&
          validId(req.body?.toolCallId),
        400,
        "INVALID_APPROVAL",
        "必须明确确认或拒绝当前命令",
      );
      const runtime = services.runtime();
      await runtime.initialize();
      const run = runtime.store.run(owner, checkedId(req.params.id));
      await runtime.approve(
        owner,
        run.id,
        req.body.toolCallId,
        req.body.approved,
        capability(owner, sessionId, run.targets),
      );
      res.json({ accepted: true });
    }),
  );
  router.get(
    "/jobs/:id/output",
    route(async (req, res) => {
      const { owner, sessionId } = identity(req);
      await services.session(owner, sessionId);
      const runtime = services.runtime();
      await runtime.initialize();
      const job = runtime.store.job(owner, checkedId(req.params.id));
      const run = runtime.store.run(owner, job.runId);
      const args = {
        stdoutOffset: naturalNumber(req.query.stdoutOffset),
        stderrOffset: naturalNumber(req.query.stderrOffset),
        tail: req.query.tail === "true",
        waitSeconds: 0,
      };
      res.json(
        await runtime.jobs.read(
          owner,
          run,
          job.id,
          args,
          256 * 1024,
          new AbortController().signal,
        ),
      );
    }),
  );
  router.use(
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      if (error instanceof RuntimeError)
        res
          .status(error.status)
          .json({ code: error.code, error: error.message });
      else
        res.status(503).json({
          code: "RUNTIME_UNAVAILABLE",
          error: "Agent 服务暂不可用；不会自动重放命令，请稍后检查任务状态",
        });
    },
  );
  return router;
}
