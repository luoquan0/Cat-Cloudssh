import { WebSocket } from "ws";

export interface OwnerSessionHeartbeatOptions<TSession extends { id: string }> {
  ws: WebSocket;
  getCurrentOwnerSession: () => TSession | null;
  hasCurrentHostAccess: (session: TSession) => Promise<boolean>;
  hasCurrentAuthenticationAccess?: () => Promise<boolean>;
  onAccessRevoked: (session: TSession) => void;
  onAuthenticationExpired?: () => void;
  onPongTimeout: () => void;
  intervalMs?: number;
  /** Number of consecutive heartbeat intervals that may miss a Pong before the socket is terminated. */
  maxMissedPongs?: number;
}

export interface OwnerSessionHeartbeat {
  stop: () => void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_MISSED_PONGS = 3;

export function startOwnerSessionHeartbeat<TSession extends { id: string }>(
  options: OwnerSessionHeartbeatOptions<TSession>,
): OwnerSessionHeartbeat {
  const {
    ws,
    getCurrentOwnerSession,
    hasCurrentHostAccess,
    hasCurrentAuthenticationAccess,
    onAccessRevoked,
    onAuthenticationExpired,
    onPongTimeout,
    intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    maxMissedPongs = DEFAULT_MAX_MISSED_PONGS,
  } = options;
  const missedPongLimit =
    Number.isFinite(maxMissedPongs) && maxMissedPongs > 0
      ? Math.floor(maxMissedPongs)
      : DEFAULT_MAX_MISSED_PONGS;
  let missedPongs = 0;
  let stopped = false;
  let accessCheckInFlight: Promise<void> | null = null;
  let authenticationCheckInFlight: Promise<void> | null = null;

  const handlePong = () => {
    missedPongs = 0;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    ws.off("pong", handlePong);
  };

  const verifyOwnerAccess = () => {
    if (accessCheckInFlight) return;
    const checkedSession = getCurrentOwnerSession();
    if (!checkedSession) return;

    const operation = hasCurrentHostAccess(checkedSession)
      .catch(() => false)
      .then((allowed) => {
        if (stopped || allowed) return;
        const currentSession = getCurrentOwnerSession();
        if (currentSession?.id === checkedSession.id) {
          onAccessRevoked(currentSession);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (accessCheckInFlight === operation) {
          accessCheckInFlight = null;
        }
      });
    accessCheckInFlight = operation;
  };

  const verifyAuthenticationAccess = () => {
    if (!hasCurrentAuthenticationAccess || authenticationCheckInFlight) return;
    const operation = hasCurrentAuthenticationAccess()
      .catch(() => false)
      .then((allowed) => {
        if (stopped || allowed) return;
        stop();
        onAuthenticationExpired?.();
      })
      .catch(() => {})
      .finally(() => {
        if (authenticationCheckInFlight === operation) {
          authenticationCheckInFlight = null;
        }
      });
    authenticationCheckInFlight = operation;
  };

  ws.on("pong", handlePong);
  const interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      stop();
      return;
    }
    // Do not kill an otherwise healthy terminal after one delayed Pong. Browser
    // tabs and the Node event loop can both be briefly delayed by large Agent
    // output bursts, background-tab throttling, or GC. Requiring several
    // consecutive misses still detects dead peers while avoiding false drops.
    if (missedPongs >= missedPongLimit) {
      stop();
      onPongTimeout();
      return;
    }

    missedPongs += 1;
    ws.ping();
    // 登录过期只关闭浏览器附件，不销毁后台 SSH 或远端 tmux。
    verifyAuthenticationAccess();
    // 协议级 Pong 只能证明连接存活；主机权限必须独立复查。
    verifyOwnerAccess();
  }, intervalMs);

  return { stop };
}
