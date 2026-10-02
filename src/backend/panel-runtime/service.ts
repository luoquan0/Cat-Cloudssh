import type { RuntimeTarget } from "../../types/panel-runtime.js";
import {
  createCurrentRepositoryContext,
  createCurrentSessionRepository,
  createCurrentUserRepository,
} from "../database/repositories/factory.js";
import { DatabaseSaveTrigger } from "../utils/database-save-trigger.js";
import { PermissionManager } from "../utils/permission-manager.js";
import { AuthManager } from "../utils/auth-manager.js";
import { PanelRuntime } from "./runtime.js";
import { RuntimeStore, requireValue } from "./store.js";
import { RuntimeJobs } from "./jobs.js";
import type { RuntimeModelConfig } from "./model.js";

export async function authorizeRuntimeSession(
  owner: string,
  sessionId: string,
): Promise<void> {
  const session = await createCurrentSessionRepository().findById(sessionId);
  requireValue(
    session &&
      session.userId === owner &&
      Number.isFinite(Date.parse(session.expiresAt)) &&
      Date.parse(session.expiresAt) > Date.now(),
    403,
    "SESSION_EXPIRED",
    "登录会话已失效，任务已暂停；重新登录后可检查并继续",
  );
  const payload = await AuthManager.getInstance().verifyJWTToken(
    session.jwtToken,
  );
  requireValue(
    payload && payload.userId === owner && !payload.pendingTOTP,
    403,
    "SESSION_REVOKED",
    "登录授权已撤销，任务已暂停",
  );
  const user = await createCurrentUserRepository().findById(owner);
  requireValue(user, 403, "USER_UNAVAILABLE", "账号不可用");
}
export async function authorizeRuntimeTarget(
  owner: string,
  target: RuntimeTarget,
): Promise<void> {
  const access = await PermissionManager.getInstance().canAccessHost(
    owner,
    target.hostId,
    "connect",
    target.projectHostId,
  );
  requireValue(
    access.hasAccess,
    403,
    "HOST_ACCESS_DENIED",
    "服务器连接权限已撤销",
  );
}
export function createCurrentPanelRuntime(
  config: () => Promise<RuntimeModelConfig>,
): PanelRuntime {
  const { sqlite } = createCurrentRepositoryContext();
  requireValue(sqlite, 503, "DATABASE_UNAVAILABLE", "数据库尚未就绪");
  const store = new RuntimeStore(sqlite, () =>
    DatabaseSaveTrigger.forceSave("panel_agent_runtime"),
  );
  return new PanelRuntime(
    store,
    new RuntimeJobs(store, authorizeRuntimeTarget),
    { config },
  );
}
