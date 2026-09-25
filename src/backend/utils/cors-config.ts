import cors from "cors";
import type { Request, Response, NextFunction } from "express";
import { getRequestOrigin } from "./request-origin.js";

const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const ELECTRON_FILE_ORIGIN = "file://";

function getAllowedOrigins(): string[] {
  const envOrigins = process.env.CORS_ALLOWED_ORIGINS;
  if (!envOrigins) return [];
  return envOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function createCorsMiddleware(
  methods: string[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  extraHeaders: string[] = [],
) {
  const allowedHeaders = [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
    "User-Agent",
    "X-Electron-App",
    "Cache-Control",
    "x-admin-target-user",
    ...extraHeaders,
  ];

  return (req: Request, res: Response, next: NextFunction) => {
    const handler = cors({
      origin: (origin, callback) => {
        // No origin = same-origin or non-browser request (curl, internal service calls)
        if (!origin) return callback(null, true);

        if (
          process.env.NODE_ENV !== "production" &&
          DEV_ORIGINS.includes(origin)
        ) {
          return callback(null, true);
        }
        if (origin.startsWith(ELECTRON_FILE_ORIGIN))
          return callback(null, true);

        const configured = getAllowedOrigins();
        if (
          configured.includes(origin) ||
          (process.env.NODE_ENV !== "production" && configured.includes("*"))
        )
          return callback(null, true);

        const sameOrigin = getRequestOrigin(req);
        if (origin === sameOrigin) return callback(null, true);

        // Reverse proxies may terminate HTTPS or rewrite ports without sending
        // every X-Forwarded-* header consistently. In production deployments the
        // browser origin can therefore differ by scheme/port even though the
        // request is still for the same public host. Allow same-host origins so
        // RDP/VNC/Telnet token requests do not fail with a generic server error.
        if (
          hostnameOf(origin) &&
          hostnameOf(origin) === hostnameOf(sameOrigin)
        ) {
          return callback(null, true);
        }

        callback(new Error("Not allowed by CORS"));
      },
      credentials: true,
      methods,
      allowedHeaders,
    });
    handler(req, res, next);
  };
}
