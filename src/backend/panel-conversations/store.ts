import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ConversationHost,
  ConversationInfo,
  ConversationMessage,
  ConversationPage,
} from "../../types/panel-conversation.js";

export class ConversationError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "CONVERSATION_INVALID") {
    super(message);
  }
}

const MiB = 1024 * 1024;
const initialized = new WeakSet<Database.Database>();
const idPattern = /^[A-Za-z0-9_.:-]{1,160}$/;

export function validId(value: unknown): string {
  if (typeof value !== "string" || !idPattern.test(value)) {
    throw new ConversationError("对话或消息 ID 无效");
  }
  return value;
}

export function parseHosts(value: unknown): ConversationHost[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new ConversationError("服务器列表无效");
  const result = new Map<string, ConversationHost>();
  for (const item of value) {
    if (!item || typeof item !== "object") throw new ConversationError("服务器无效");
    const hostId = Number(item.hostId);
    const projectHostId = item.projectHostId === undefined ? undefined : Number(item.projectHostId);
    if (!Number.isSafeInteger(hostId) || hostId < 1 ||
        (projectHostId !== undefined && (!Number.isSafeInteger(projectHostId) || projectHostId < 1))) {
      throw new ConversationError("服务器 ID 无效");
    }
    const host = { hostId, ...(projectHostId === undefined ? {} : { projectHostId }) };
    result.set(`${hostId}:${projectHostId ?? ""}`, host);
  }
  return [...result.values()];
}

/** Do not truncate the archive. Reject oversized writes explicitly instead. */
export function parseMessages(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value) || value.length > 500) throw new ConversationError("每批最多保存 500 条消息");
  return value.map((raw): ConversationMessage => {
    if (!raw || typeof raw !== "object" || !["user", "assistant", "tool"].includes(raw.role) ||
        typeof raw.content !== "string" || raw.content.length > 1_000_000) {
      throw new ConversationError("消息格式或长度无效");
    }
    const message: ConversationMessage = { id: validId(raw.id), role: raw.role, content: raw.content };
    for (const field of ["toolCallId", "name", "model"] as const) {
      if (raw[field] !== undefined) {
        if (typeof raw[field] !== "string" || raw[field].length > 256) throw new ConversationError("消息元数据无效");
        message[field] = raw[field];
      }
    }
    if (raw.toolCalls !== undefined) {
      if (!Array.isArray(raw.toolCalls) || raw.toolCalls.length > 100) throw new ConversationError("工具调用列表无效");
      message.toolCalls = raw.toolCalls.map((call: Record<string, unknown>) => {
        if (!call || !["run_terminal_command", "read_terminal_context"].includes(String(call.name)) ||
            !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
          throw new ConversationError("工具调用格式无效");
        }
        if (JSON.stringify(call.arguments).length > 32_000) throw new ConversationError("工具参数过长");
        return { id: validId(call.id), name: call.name as "run_terminal_command" | "read_terminal_context", arguments: call.arguments as Record<string, unknown> };
      });
    }
    if (raw.attachments !== undefined) {
      if (!Array.isArray(raw.attachments) || raw.attachments.length > 6) throw new ConversationError("附件数量无效");
      message.attachments = raw.attachments.map((attachment: Record<string, unknown>) => {
        if (!attachment || typeof attachment.name !== "string" || attachment.name.length > 160 ||
            typeof attachment.mimeType !== "string" || attachment.mimeType.length > 160 ||
            !["text", "image", "file"].includes(String(attachment.kind)) ||
            !Number.isSafeInteger(attachment.size) || Number(attachment.size) < 0) {
          throw new ConversationError("附件格式无效");
        }
        const saved: NonNullable<ConversationMessage["attachments"]>[number] = {
          id: validId(attachment.id), name: attachment.name, mimeType: attachment.mimeType,
          size: Number(attachment.size), kind: attachment.kind as "text" | "image" | "file",
        };
        if (attachment.text !== undefined) {
          if (typeof attachment.text !== "string" || attachment.text.length > 80_000) throw new ConversationError("附件文本过长");
          saved.text = attachment.text;
        }
        if (attachment.dataUrl !== undefined) {
          if (typeof attachment.dataUrl !== "string" || attachment.dataUrl.length > 6_000_000 ||
              !/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(attachment.dataUrl)) {
            throw new ConversationError("图片附件无效");
          }
          saved.dataUrl = attachment.dataUrl;
        }
        return saved;
      });
    }
    return message;
  });
}

interface Row {
  id: string; title: string; hosts: string; createdAt: string; updatedAt: string;
  revision: number; messageCount: number; sizeBytes: number; summary: string;
  summaryThrough: number; summaryModel: string | null; autoCompact: number;
}
const columns = `id, title, hosts, created_at AS createdAt, updated_at AS updatedAt,
  revision, message_count AS messageCount, size_bytes AS sizeBytes, summary,
  summary_through AS summaryThrough, summary_model AS summaryModel, auto_compact AS autoCompact`;
const info = (row: Row): ConversationInfo => ({ ...row, hosts: JSON.parse(row.hosts), autoCompact: !!row.autoCompact });
const limit = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

export class ConversationStore {
  readonly maxConversationBytes: number;
  readonly maxUserBytes: number;
  constructor(readonly db: Database.Database, private readonly afterWrite: () => Promise<void> = async () => {},
    limits: { conversationBytes?: number; userBytes?: number } = {}) {
    this.maxConversationBytes = limits.conversationBytes ?? limit(process.env.PANEL_AGENT_CONVERSATION_MAX_BYTES, 64 * MiB);
    this.maxUserBytes = limits.userBytes ?? limit(process.env.PANEL_AGENT_USER_HISTORY_MAX_BYTES, 256 * MiB);
    if (!initialized.has(db)) {
      // Additive, idempotent migration inside the existing encrypted/snapshotted database.
      db.exec(`CREATE TABLE IF NOT EXISTS panel_agent_conversations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL, hosts TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '',
        summary_through INTEGER NOT NULL DEFAULT 0, summary_model TEXT,
        auto_compact INTEGER NOT NULL DEFAULT 1,
        import_key TEXT, UNIQUE(user_id, import_key)
      );
      CREATE INDEX IF NOT EXISTS panel_agent_conversations_owner_updated
        ON panel_agent_conversations(user_id, updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS panel_agent_conversation_messages (
        conversation_id TEXT NOT NULL REFERENCES panel_agent_conversations(id) ON DELETE CASCADE,
        id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
        body TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(conversation_id, id), UNIQUE(conversation_id, seq)
      );
      CREATE INDEX IF NOT EXISTS panel_agent_messages_turns
        ON panel_agent_conversation_messages(conversation_id, role, seq);
      CREATE TRIGGER IF NOT EXISTS panel_agent_conversation_cleanup
        AFTER DELETE ON panel_agent_conversations BEGIN
        DELETE FROM panel_agent_conversation_messages WHERE conversation_id = OLD.id;
      END;
      CREATE TRIGGER IF NOT EXISTS panel_agent_user_cleanup
        AFTER DELETE ON users BEGIN
        DELETE FROM panel_agent_conversations WHERE user_id = OLD.id;
      END;`);
      initialized.add(db);
    }
  }

  async flush(): Promise<void> { await this.afterWrite(); }

  get(userId: string, id: string): ConversationInfo {
    const row = this.db.prepare(`SELECT ${columns} FROM panel_agent_conversations WHERE id=? AND user_id=?`).get(validId(id), userId) as Row | undefined;
    if (!row) throw new ConversationError("对话不存在或无权访问", 404, "CONVERSATION_NOT_FOUND");
    return info(row);
  }

  create(userId: string, id: string, title: string, hosts: ConversationHost[], importKey?: string): ConversationInfo {
    validId(id);
    const old = this.db.prepare("SELECT user_id FROM panel_agent_conversations WHERE id=?").get(id) as { user_id: string } | undefined;
    if (old) {
      if (old.user_id !== userId) throw new ConversationError("对话 ID 已存在", 409, "CONVERSATION_CONFLICT");
      return this.get(userId, id);
    }
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM panel_agent_conversations WHERE user_id=?").get(userId) as { n: number };
    if (count.n >= 1000) throw new ConversationError("已达到 1000 个对话上限，请先导出或删除旧对话", 413, "HISTORY_QUOTA_EXCEEDED");
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO panel_agent_conversations(id,user_id,title,hosts,created_at,updated_at,import_key) VALUES(?,?,?,?,?,?,?)`)
      .run(id, userId, this.title(title), JSON.stringify(parseHosts(hosts)), now, now, importKey ?? null);
    return this.get(userId, id);
  }

  private title(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || value.length > 200) throw new ConversationError("标题需为 1–200 个字符");
    return value.trim();
  }

  checkRevision(current: ConversationInfo, expected: unknown): void {
    if (!Number.isSafeInteger(expected) || expected !== current.revision) {
      throw new ConversationError("对话已在其他窗口更新，请重新载入后继续；本地未保存内容不会被自动覆盖", 409, "CONVERSATION_CONFLICT");
    }
  }

  list(userId: string, options: { hostId?: number; search?: string; offset?: number; limit?: number } = {}) {
    const conditions = ["user_id = ?"];
    const params: (string | number)[] = [userId];
    if (options.hostId !== undefined) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(hosts) WHERE json_extract(value,'$.hostId') = ?)");
      params.push(options.hostId);
    }
    if (options.search) {
      conditions.push("(title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM panel_agent_conversation_messages m WHERE m.conversation_id=c.id AND m.body LIKE ? ESCAPE '\\'))");
      const pattern = `%${options.search.slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`;
      params.push(pattern, pattern);
    }
    const pageSize = Math.max(1, Math.min(50, options.limit ?? 30));
    const offset = Math.max(0, options.offset ?? 0);
    const rows = this.db.prepare(`SELECT ${columns} FROM panel_agent_conversations c WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...params, pageSize + 1, offset) as Row[];
    return { items: rows.slice(0, pageSize).map(info), nextOffset: rows.length > pageSize ? offset + pageSize : null };
  }

  message(userId: string, id: string, messageId: string): ConversationMessage | null {
    this.get(userId, id);
    const row = this.db.prepare("SELECT body,seq,created_at FROM panel_agent_conversation_messages WHERE conversation_id=? AND id=?").get(id, messageId) as { body: string; seq: number; created_at: string } | undefined;
    return row ? { ...JSON.parse(row.body), seq: row.seq, createdAt: row.created_at } : null;
  }

  messages(userId: string, id: string, after = 0, before = Number.MAX_SAFE_INTEGER, count = 100): ConversationMessage[] {
    this.get(userId, id);
    const rows = this.db.prepare("SELECT body,seq,created_at FROM panel_agent_conversation_messages WHERE conversation_id=? AND seq>? AND seq<? ORDER BY seq DESC LIMIT ?").all(id, after, before, count) as Array<{ body: string; seq: number; created_at: string }>;
    return rows.reverse().map((row) => ({ ...JSON.parse(row.body), seq: row.seq, createdAt: row.created_at }));
  }

  page(userId: string, id: string, before?: number): ConversationPage {
    const conversation = this.get(userId, id);
    const messages = this.messages(userId, id, 0, before, 100);
    return { conversation, messages, before: (messages[0]?.seq ?? 0) > 1 ? messages[0].seq! : null };
  }

  append(userId: string, id: string, expected: number, raw: unknown, hosts: ConversationHost[] = []): ConversationInfo {
    const incoming = parseMessages(raw);
    return this.db.transaction(() => {
      const current = this.get(userId, id);
      const additions: Array<{ message: ConversationMessage; body: string }> = [];
      const seen = new Map<string, string>();
      for (const message of incoming) {
        const body = JSON.stringify(message);
        const existing = this.db.prepare("SELECT body FROM panel_agent_conversation_messages WHERE conversation_id=? AND id=?").get(id, message.id) as { body: string } | undefined;
        const known = seen.get(message.id) ?? existing?.body;
        if (known !== undefined) {
          if (known !== body) throw new ConversationError("消息 ID 内容冲突，原记录未修改", 409, "MESSAGE_CONFLICT");
          continue;
        }
        seen.set(message.id, body);
        additions.push({ message, body });
      }
      const mergedHosts = parseHosts([...current.hosts, ...hosts].filter((host, i, all) => all.findIndex((other) => other.hostId === host.hostId && other.projectHostId === host.projectHostId) === i));
      if (!additions.length && JSON.stringify(mergedHosts) === JSON.stringify(current.hosts)) return current;
      this.checkRevision(current, expected);
      const bytes = additions.reduce((n, row) => n + Buffer.byteLength(row.body), 0);
      const total = this.db.prepare("SELECT COALESCE(SUM(size_bytes),0) AS n FROM panel_agent_conversations WHERE user_id=?").get(userId) as { n: number };
      if (bytes > 40 * MiB || current.sizeBytes + bytes > this.maxConversationBytes || total.n + bytes > this.maxUserBytes || current.messageCount + additions.length > 20_000) {
        throw new ConversationError("服务器对话存储达到上限。请导出或删除旧记录；摘要压缩不会删除原文或释放归档容量", 413, "HISTORY_QUOTA_EXCEEDED");
      }
      const now = new Date().toISOString();
      let seq = current.messageCount;
      const insert = this.db.prepare("INSERT INTO panel_agent_conversation_messages(conversation_id,id,seq,role,body,created_at) VALUES(?,?,?,?,?,?)");
      for (const row of additions) insert.run(id, row.message.id, ++seq, row.message.role, row.body, now);
      this.db.prepare("UPDATE panel_agent_conversations SET revision=revision+1,message_count=?,size_bytes=size_bytes+?,hosts=?,updated_at=? WHERE id=? AND user_id=?")
        .run(seq, bytes, JSON.stringify(mergedHosts), now, id, userId);
      return this.get(userId, id);
    })();
  }

  update(userId: string, id: string, expected: number, patch: { title?: string; autoCompact?: boolean }): ConversationInfo {
    const current = this.get(userId, id);
    this.checkRevision(current, expected);
    if (patch.autoCompact !== undefined && typeof patch.autoCompact !== "boolean") throw new ConversationError("自动压缩设置无效");
    this.db.prepare("UPDATE panel_agent_conversations SET title=?,auto_compact=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=?")
      .run(patch.title === undefined ? current.title : this.title(patch.title), Number(patch.autoCompact ?? current.autoCompact), new Date().toISOString(), id, userId);
    return this.get(userId, id);
  }

  summarize(userId: string, id: string, expected: number, summary: string, through: number, model: string): ConversationInfo {
    const current = this.get(userId, id);
    this.checkRevision(current, expected);
    if (!summary.trim() || summary.length > 12_000 || through <= current.summaryThrough || through >= current.messageCount) throw new ConversationError("摘要边界或内容无效");
    this.db.prepare("UPDATE panel_agent_conversations SET summary=?,summary_through=?,summary_model=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=?")
      .run(summary, through, model, new Date().toISOString(), id, userId);
    return this.get(userId, id);
  }

  delete(userId: string, id: string, expected: number): void {
    this.checkRevision(this.get(userId, id), expected);
    this.db.prepare("DELETE FROM panel_agent_conversations WHERE id=? AND user_id=?").run(id, userId);
  }

  deleteAll(userId: string, hostId?: number): number {
    const where = hostId === undefined ? "" : " AND EXISTS (SELECT 1 FROM json_each(hosts) WHERE json_extract(value,'$.hostId')=?)";
    return this.db.prepare(`DELETE FROM panel_agent_conversations WHERE user_id=?${where}`).run(...(hostId === undefined ? [userId] : [userId, hostId])).changes;
  }

  import(userId: string, title: string, raw: unknown, legacyId: string): ConversationInfo {
    if (typeof legacyId !== "string" || legacyId.length > 200) throw new ConversationError("旧记录标识无效");
    const messages = parseMessages(raw);
    const key = crypto.createHash("sha256").update(legacyId + "\0" + JSON.stringify(messages)).digest("hex");
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT id FROM panel_agent_conversations WHERE user_id=? AND import_key=?").get(userId, key) as { id: string } | undefined;
      if (previous) return this.get(userId, previous.id);
      const created = this.create(userId, crypto.randomUUID(), this.title(title), [], key);
      return this.append(userId, created.id, 0, messages);
    })();
  }

  fork(userId: string, id: string, messageId: string, newId: string): ConversationInfo {
    const parent = this.get(userId, id);
    const boundary = this.message(userId, id, validId(messageId));
    if (!boundary || boundary.role !== "user") throw new ConversationError("只能从用户消息创建重试分支");
    const raw = this.messages(userId, id, 0, boundary.seq! + 1, 20_000);
    return this.db.transaction(() => {
      const child = this.create(userId, newId, `${parent.title.slice(0, 180)} · 重试`, parent.hosts);
      let result = child;
      for (let i = 0; i < raw.length; i += 500) result = this.append(userId, child.id, result.revision, raw.slice(i, i + 500));
      if (parent.summaryThrough > 0 && parent.summaryThrough < boundary.seq!) {
        result = this.summarize(userId, child.id, result.revision, parent.summary, parent.summaryThrough, parent.summaryModel ?? "");
      }
      return result;
    })();
  }
}
