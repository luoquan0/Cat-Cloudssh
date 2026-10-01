import express, {
  type RequestHandler,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { PermissionManager } from "../../utils/permission-manager.js";
import {
  getCurrentRepositorySqlite,
  createCurrentRepositoryWriteHook,
} from "../repositories/factory.js";
import {
  PanelConversationRepository,
  ConversationError,
  validateConversationId,
} from "../repositories/panel-conversation-repository.js";
import type { AuthenticatedRequest } from "../../../types/index.js";
import type { PanelConversation } from "../../../types/panel-conversations.js";

export function currentConversationRepository(): PanelConversationRepository {
  return new PanelConversationRepository(
    getCurrentRepositorySqlite(),
    createCurrentRepositoryWriteHook("panel_conversation_write"),
  );
}

async function defaultHostAccess(
  userId: string,
  hostId: number,
): Promise<boolean> {
  return (
    await PermissionManager.getInstance().canAccessHost(
      userId,
      hostId,
      "connect",
    )
  ).hasAccess;
}

export async function authorizeConversation(
  userId: string,
  id: string,
): Promise<PanelConversation> {
  const conversation = currentConversationRepository().get(
    userId,
    validateConversationId(id),
  );
  if (
    conversation.hostId !== null &&
    !(await defaultHostAccess(userId, conversation.hostId))
  ) {
    throw new ConversationError(
      "当前账号无权访问此服务器的聊天记录",
      403,
      "HOST_ACCESS_DENIED",
    );
  }
  return conversation;
}

export interface ConversationRouterDependencies {
  authenticate: RequestHandler;
  repository?: () => PanelConversationRepository;
  canAccessHost?: (userId: string, hostId: number) => Promise<boolean>;
  summarize: (
    previous: string,
    transcript: string,
    model?: string,
  ) => Promise<string>;
}

function hostIdFrom(value: unknown): number | null {
  if (value === null || value === undefined || value === "general") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new ConversationError("无效服务器编号");
  return number;
}
function revisionFrom(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new ConversationError("缺少有效的对话版本号");
  return Number(value);
}
function titleFrom(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160)
    throw new ConversationError("标题需为 1–160 个字符");
  return value;
}

export function createPanelConversationRouter(
  deps: ConversationRouterDependencies,
) {
  const router = express.Router();
  const repository = deps.repository ?? currentConversationRepository;
  const canAccessHost = deps.canAccessHost ?? defaultHostAccess;
  const compacting = new Set<string>();
  const lastCompaction = new Map<string, number>();
  const user = (req: Request) => (req as AuthenticatedRequest).userId!;
  const id = (req: Request) => validateConversationId(req.params.id);
  const access = async (req: Request) => {
    const conversation = repository().get(user(req), id(req));
    if (
      conversation.hostId !== null &&
      !(await canAccessHost(user(req), conversation.hostId))
    ) {
      throw new ConversationError(
        "服务器访问权限已撤销",
        403,
        "HOST_ACCESS_DENIED",
      );
    }
    return conversation;
  };
  const route =
    (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
    (req, res, next) => {
      void fn(req, res).catch(next);
    };

  router.use(deps.authenticate, (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!user(req)) {
      res.status(401).json({ error: "需要登录", code: "AUTH_REQUIRED" });
      return;
    }
    next();
  });

  router.get(
    "/",
    route(async (req, res) => {
      const hostId =
        req.query.hostId === "all" ? undefined : hostIdFrom(req.query.hostId);
      const offset = Number(req.query.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new ConversationError("无效分页参数");
      if (hostId != null && !(await canAccessHost(user(req), hostId)))
        throw new ConversationError("无权访问服务器", 403);
      const records = repository().list(
        user(req),
        hostId,
        String(req.query.search ?? ""),
        offset,
      );
      const visible: PanelConversation[] = [];
      for (const record of records) {
        if (
          record.hostId === null ||
          hostId === record.hostId ||
          (await canAccessHost(user(req), record.hostId))
        )
          visible.push(record);
      }
      res.json({
        conversations: visible,
        nextOffset: records.length === 50 ? offset + 50 : null,
      });
    }),
  );
  router.post(
    "/",
    route(async (req, res) => {
      const hostId = hostIdFrom(req.body?.hostId);
      if (hostId !== null && !(await canAccessHost(user(req), hostId)))
        throw new ConversationError("无权访问服务器", 403);
      const requestId =
        req.body?.id === undefined
          ? undefined
          : validateConversationId(req.body.id);
      res
        .status(201)
        .json(
          await repository().create(
            user(req),
            hostId,
            titleFrom(req.body?.title ?? "新对话"),
            requestId,
          ),
        );
    }),
  );
  router.delete(
    "/",
    route(async (req, res) => {
      if (req.body?.confirmation !== "DELETE_SCOPE")
        throw new ConversationError("删除全部历史需要明确确认");
      if (!("hostId" in (req.body ?? {})))
        throw new ConversationError("必须指定删除分类");
      await repository().deleteScope(user(req), hostIdFrom(req.body.hostId));
      res.status(204).end();
    }),
  );
  router.get(
    "/:id",
    route(async (req, res) => res.json(await access(req))),
  );
  router.get(
    "/:id/messages",
    route(async (req, res) => {
      await access(req);
      const before =
        req.query.before === undefined ? undefined : Number(req.query.before);
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
        throw new ConversationError("无效消息游标");
      res.json(repository().page(user(req), id(req), before));
    }),
  );
  router.post(
    "/:id/messages",
    route(async (req, res) => {
      await access(req);
      const model = req.body?.model ?? "";
      if (typeof model !== "string" || model.length > 256)
        throw new ConversationError("无效模型名称");
      res.json(
        await repository().append(
          user(req),
          id(req),
          revisionFrom(req.body?.revision),
          req.body?.messages,
          model,
        ),
      );
    }),
  );
  router.patch(
    "/:id",
    route(async (req, res) => {
      await access(req);
      res.json(
        await repository().rename(
          user(req),
          id(req),
          revisionFrom(req.body?.revision),
          titleFrom(req.body?.title),
        ),
      );
    }),
  );
  router.delete(
    "/:id",
    route(async (req, res) => {
      // The owner may remove their own data even after losing host access.
      repository().get(user(req), id(req));
      await repository().delete(user(req), id(req));
      res.status(204).end();
    }),
  );
  router.get(
    "/:id/context",
    route(async (req, res) => {
      await access(req);
      res.json(repository().context(user(req), id(req)));
    }),
  );
  router.post(
    "/:id/compact",
    route(async (req, res) => {
      const record = await access(req);
      const repo = repository();
      const expected = revisionFrom(req.body?.revision);
      if (expected !== record.revision)
        throw new ConversationError(
          "对话已更新，请刷新后重试",
          409,
          "CONVERSATION_CONFLICT",
        );
      const input = repo.compactionInput(user(req), record.id);
      if (!input) {
        res.json({ conversation: record, compacted: false });
        return;
      }
      const key = user(req);
      if (compacting.has(key))
        throw new ConversationError(
          "正在生成摘要，请稍候",
          409,
          "COMPACTION_BUSY",
        );
      if (Date.now() - (lastCompaction.get(key) ?? 0) < 3000)
        throw new ConversationError("摘要请求过于频繁", 429);
      const model = req.body?.model;
      if (
        model !== undefined &&
        (typeof model !== "string" || model.length > 256)
      )
        throw new ConversationError("无效模型名");
      compacting.add(key);
      try {
        const summary = await deps.summarize(record.summary, input.text, model);
        // Recheck permissions after the remote model call; no original row is deleted.
        await access(req);
        const saved = await repo.saveSummary(
          user(req),
          record.id,
          expected,
          input.through,
          summary,
        );
        res.json({ conversation: saved, compacted: true });
      } finally {
        compacting.delete(key);
        lastCompaction.set(key, Date.now());
        if (lastCompaction.size > 2000) {
          for (const [owner, time] of lastCompaction)
            if (Date.now() - time > 60_000) lastCompaction.delete(owner);
        }
      }
    }),
  );
  router.get(
    "/:id/export",
    route(async (req, res) => {
      const conversation = await access(req);
      const repo = repository();
      // Export all original messages, not merely the visible page or summary.
      const pages = [];
      let before: number | undefined = conversation.messageCount + 1;
      while (before !== undefined) {
        const page = repo.page(user(req), conversation.id, before, 200);
        pages.push(page.messages);
        before = page.nextBefore ?? undefined;
      }
      res.type("application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="conversation-${conversation.id}.json"`,
      );
      res.write(
        JSON.stringify({ schemaVersion: 1, conversation }).slice(0, -1) +
          ',"messages":[',
      );
      let first = true;
      for (const page of pages.reverse())
        for (const message of page) {
          if (res.destroyed) return;
          const writable = res.write(
            (first ? "" : ",") + JSON.stringify(message),
          );
          first = false;
          if (!writable)
            await new Promise<void>((resolve) => {
              const done = () => {
                res.off("drain", done);
                res.off("close", done);
                resolve();
              };
              res.once("drain", done);
              res.once("close", done);
            });
        }
      res.end("]}");
    }),
  );
  router.use(
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      const shaped = error as {
        status?: number;
        code?: string;
        message?: string;
      };
      res.status(shaped.status ?? 500).json({
        code: shaped.code ?? "CONVERSATION_ERROR",
        error: shaped.status
          ? shaped.message
          : "聊天记录保存失败；请保留当前页面并重试或导出本地副本",
      });
    },
  );
  return router;
}
