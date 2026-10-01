import crypto from "node:crypto";
import express, { type RequestHandler, type Request } from "express";
import type { AuthenticatedRequest } from "../../types/index.js";
import type { ConversationHost, ConversationInfo, ConversationMessage } from "../../types/panel-conversation.js";
import { ConversationError, ConversationStore, parseHosts, validId } from "./store.js";
import { modelContext, needsSummary, summarySource } from "./context.js";

export interface ConversationDependencies {
  getStore(): ConversationStore;
  canAccessHost(userId: string, host: ConversationHost): Promise<boolean>;
}
export type Summarize = (previous: string, source: string, model?: string) => Promise<{ text: string; model: string }>;
const running = new Set<string>();

async function exclusive<T>(userId: string, id: string, task: () => Promise<T>): Promise<T> {
  const key = `${userId}:${id}`;
  if (running.has(key)) throw new ConversationError("此对话正在生成或压缩，请稍后重试", 409, "CONVERSATION_BUSY");
  running.add(key);
  try { return await task(); } finally { running.delete(key); }
}
const user = (req: Request): string => {
  const id = (req as AuthenticatedRequest).userId;
  if (!id) throw new ConversationError("请先登录", 401, "AUTH_REQUIRED");
  return id;
};
const integer = (value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > maximum) throw new ConversationError("分页参数无效");
  return n;
};

export async function checkConversationAccess(deps: ConversationDependencies, userId: string, record: ConversationInfo): Promise<void> {
  for (const host of record.hosts) {
    if (!(await deps.canAccessHost(userId, host))) throw new ConversationError("已无权访问此对话关联的服务器", 403, "HOST_ACCESS_REVOKED");
  }
}

async function compact(deps: ConversationDependencies, store: ConversationStore, userId: string, record: ConversationInfo, summarize: Summarize, model?: string): Promise<ConversationInfo> {
  const source = summarySource(store, userId, record);
  if (!source) return record;
  const result = await summarize(record.summary, source.text, model);
  // Permission may have been revoked while the model was working.
  await checkConversationAccess(deps, userId, store.get(userId, record.id));
  const updated = store.summarize(userId, record.id, record.revision, result.text, source.through, result.model);
  await store.flush();
  return updated;
}

export function createConversationRouter(deps: ConversationDependencies, authenticate: RequestHandler, summarize: Summarize) {
  const router = express.Router();
  router.use(authenticate);
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
  const handle = (task: (req: express.Request, res: express.Response) => Promise<void>): RequestHandler =>
    (req, res, next) => { Promise.resolve().then(() => task(req, res)).catch(next); };

  router.get("/", handle(async (req, res) => {
    const userId = user(req);
    const result = deps.getStore().list(userId, {
      hostId: req.query.hostId === undefined ? undefined : integer(req.query.hostId, 0),
      search: typeof req.query.search === "string" ? req.query.search.slice(0, 200) : undefined,
      offset: integer(req.query.offset, 0, 100_000), limit: integer(req.query.limit, 30, 50),
    });
    const items: ConversationInfo[] = [];
    for (const record of result.items) {
      try { await checkConversationAccess(deps, userId, record); items.push(record); }
      catch (error) { if (!(error instanceof ConversationError) || error.status !== 403) throw error; }
    }
    res.json({ userId, items, nextOffset: result.nextOffset });
  }));
  router.post("/", handle(async (req, res) => {
    const userId = user(req);
    const hosts = parseHosts(req.body?.hosts);
    for (const host of hosts) if (!(await deps.canAccessHost(userId, host))) throw new ConversationError("无权关联该服务器", 403, "HOST_ACCESS_REVOKED");
    const store = deps.getStore();
    const record = store.create(userId, validId(req.body?.id), req.body?.title, hosts);
    await checkConversationAccess(deps, userId, record);
    await store.flush();
    res.status(201).json(record);
  }));
  router.post("/import", handle(async (req, res) => {
    const userId = user(req);
    if (req.body?.confirmOwnership !== true) throw new ConversationError("请确认旧浏览器记录属于当前账号");
    const store = deps.getStore();
    const record = store.import(userId, req.body?.title, req.body?.messages, req.body?.legacyId);
    await store.flush();
    res.status(201).json(record);
  }));
  router.delete("/", handle(async (req, res) => {
    const userId = user(req);
    if (req.body?.confirm !== "delete-all") throw new ConversationError("批量删除需要明确确认");
    const hostId = req.body?.hostId === undefined ? undefined : integer(req.body.hostId, 0);
    // Owner-only deletion remains available even after a host grant is revoked.
    const store = deps.getStore();
    const deleted = store.deleteAll(userId, hostId);
    await store.flush();
    res.json({ deleted });
  }));
  router.get("/:id", handle(async (req, res) => {
    const userId = user(req);
    const store = deps.getStore();
    const id = validId(req.params.id);
    await checkConversationAccess(deps, userId, store.get(userId, id));
    res.json(store.page(userId, id, req.query.before === undefined ? undefined : integer(req.query.before, 0)));
  }));
  router.get("/:id/export", handle(async (req, res) => {
    const userId = user(req);
    const store = deps.getStore();
    const record = store.get(userId, validId(req.params.id));
    await checkConversationAccess(deps, userId, record);
    res.setHeader("Content-Disposition", `attachment; filename="conversation-${record.id}.json"`);
    res.json({ schemaVersion: 1, conversation: record, messages: store.messages(userId, record.id, 0, undefined, 20_000) });
  }));
  router.post("/:id/messages", handle(async (req, res) => {
    const userId = user(req);
    const store = deps.getStore();
    const id = validId(req.params.id);
    const hosts = parseHosts(req.body?.hosts);
    await checkConversationAccess(deps, userId, store.get(userId, id));
    for (const host of hosts) if (!(await deps.canAccessHost(userId, host))) throw new ConversationError("无权关联该服务器", 403, "HOST_ACCESS_REVOKED");
    const record = store.append(userId, id, req.body?.revision, req.body?.messages, hosts);
    await store.flush();
    res.json(record);
  }));
  router.patch("/:id", handle(async (req, res) => {
    const userId = user(req);
    const store = deps.getStore();
    const id = validId(req.params.id);
    await checkConversationAccess(deps, userId, store.get(userId, id));
    const record = store.update(userId, id, req.body?.revision, { title: req.body?.title, autoCompact: req.body?.autoCompact });
    await store.flush();
    res.json(record);
  }));
  router.delete("/:id", handle(async (req, res) => {
    const userId = user(req);
    const store = deps.getStore();
    store.delete(userId, validId(req.params.id), req.body?.revision);
    await store.flush();
    res.status(204).end();
  }));
  router.post("/:id/compact", handle(async (req, res) => {
    const userId = user(req);
    const id = validId(req.params.id);
    await exclusive(userId, id, async () => {
      const store = deps.getStore();
      const record = store.get(userId, id);
      await checkConversationAccess(deps, userId, record);
      store.checkRevision(record, req.body?.revision);
      res.json(await compact(deps, store, userId, record, summarize, typeof req.body?.model === "string" ? req.body.model : undefined));
    });
  }));
  router.post("/:id/fork", handle(async (req, res) => {
    const userId = user(req);
    const store = deps.getStore();
    const id = validId(req.params.id);
    await checkConversationAccess(deps, userId, store.get(userId, id));
    const record = store.fork(userId, id, validId(req.body?.messageId), validId(req.body?.id));
    await store.flush();
    res.status(201).json(record);
  }));
  return router;
}

/** Called by /chat after the existing login/model/target validation. */
export async function persistedChat(
  deps: ConversationDependencies,
  userId: string,
  body: { conversationId: string; revision: number; requestId: string },
  targets: Array<{ hostId?: string | number | null }>,
  model: string,
  summarize: Summarize,
  complete: (messages: ConversationMessage[]) => Promise<{ message: { role: "assistant"; content: string; toolCalls: NonNullable<ConversationMessage["toolCalls"]> } }>,
) {
  const id = validId(body.conversationId);
  const requestId = validId(body.requestId);
  return exclusive(userId, id, async () => {
    const store = deps.getStore();
    let record = store.get(userId, id);
    await checkConversationAccess(deps, userId, record);
    for (const target of targets) {
      if (target.hostId === null || target.hostId === undefined || !record.hosts.some((host) => host.hostId === Number(target.hostId))) {
        throw new ConversationError("请先将当前服务器关联并保存到此对话", 403, "CONVERSATION_TARGET_MISMATCH");
      }
    }
    const assistantId = `model-${crypto.createHash("sha256").update(requestId).digest("hex")}`;
    const existing = store.message(userId, id, assistantId);
    if (existing) {
      await store.flush();
      return { message: { ...existing, role: "assistant" as const, toolCalls: existing.toolCalls ?? [] }, conversation: record, replayed: true };
    }
    store.checkRevision(record, body.revision);
    let compactionWarning: string | undefined;
    if (needsSummary(store, record)) {
      try { record = await compact(deps, store, userId, record, summarize, model); }
      catch (error) {
        if (error instanceof ConversationError && [403, 404, 409].includes(error.status)) throw error;
        compactionWarning = "自动摘要暂时失败，已保留原文并使用有上限的最近上下文；可稍后手动压缩。";
      }
    }
    const response = await complete(modelContext(store, userId, record));
    await checkConversationAccess(deps, userId, store.get(userId, id));
    const message: ConversationMessage = { ...response.message, id: assistantId, model };
    record = store.append(userId, id, record.revision, [message]);
    await store.flush();
    // Persist before returning a tool call, so the renderer cannot execute an unlogged call.
    return { message, conversation: record, compactionWarning };
  });
}
