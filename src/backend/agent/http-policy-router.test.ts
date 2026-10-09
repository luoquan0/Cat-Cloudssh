import http from "node:http";
import express from "express";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentHttpPolicyRouter } from "./http-policy-router.js";
import { AgentHttpPolicyStore } from "./http-policy.js";
import { setAgentHttpPolicyProvider } from "../utils/trust-loopback-proxy.js";

const resources: Array<{ server: http.Server; db: Database.Database }> = [];
afterEach(async () => {
  setAgentHttpPolicyProvider(undefined);
  for (const { server, db } of resources.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

async function setup(
  options: {
    admin?: boolean;
    apiKey?: boolean;
    pending?: boolean;
    staleMfa?: boolean;
    source?: string;
    auditFails?: boolean;
  } = {},
) {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE users(id TEXT PRIMARY KEY,totp_enabled INTEGER); CREATE TABLE webauthn_credentials(user_id TEXT); INSERT INTO users VALUES('admin',1)",
  );
  const store = new AgentHttpPolicyStore(db, async () => {}, {});
  setAgentHttpPolicyProvider(() => store.snapshot());
  const audit = vi.fn(async () => {
    if (options.auditFails) throw new Error("audit disk failure");
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Fixture represents the address already established by the trusted proxy,
    // not an arbitrary forwarded header controlled by the requesting client.
    Object.defineProperty(req, "ip", {
      value: options.source || "192.168.222.10",
    });
    Object.assign(req, {
      userId: "admin",
      sessionId: "web-session",
      apiKeyId: options.apiKey ? "api" : undefined,
      pendingTOTP: options.pending === true,
      mfaVerifiedAt:
        Math.floor(Date.now() / 1000) - (options.staleMfa ? 600 : 0),
    });
    next();
  });
  app.use(
    "/policy",
    createAgentHttpPolicyRouter(
      {
        sqlite: db,
        authenticate: (_req, _res, next) => next(),
        listManageableProjects: async () => [],
        isInstanceAdmin: async () => options.admin !== false,
        audit,
      },
      store,
    ),
  );
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push({ server, db });
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const send = (requestOrigin: string | null = origin) =>
    new Promise<{
      status: number;
      body: { code?: string; allowHttp?: boolean; source?: string };
    }>((resolve, reject) => {
      const request = http.request(
        `${origin}/policy`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(requestOrigin === null ? {} : { Origin: requestOrigin }),
          },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode!, body: JSON.parse(body) }),
          );
        },
      );
      request.on("error", reject);
      request.end(
        JSON.stringify({
          allowHttp: true,
          allowedCidrs: ["192.168.222.10/32"],
        }),
      );
    });
  return { send, store, audit };
}

describe("Agent HTTP policy administrative endpoint", () => {
  it("allows explicit same-origin LAN bootstrap with recent MFA", async () => {
    const { send, store, audit } = await setup();
    expect(await send()).toMatchObject({
      status: 200,
      body: { allowHttp: true, source: "saved" },
    });
    expect(store.snapshot().allowedCidrs).toEqual(["192.168.222.10/32"]);
    expect(audit).toHaveBeenCalledOnce();
  });
  it.each([
    [{ admin: false }, 403],
    [{ apiKey: true }, 401],
    [{ pending: true }, 401],
    [{ staleMfa: true }, 401],
    [{ source: "203.0.113.10" }, 426],
  ])(
    "rejects unauthorized administrative context %j",
    async (options, expected) => {
      const { send, store, audit } = await setup(options);
      expect((await send()).status).toBe(expected);
      expect(store.snapshot().allowHttp).toBe(false);
      expect(audit).not.toHaveBeenCalled();
    },
  );
  it.each([null, "http://untrusted.invalid"])(
    "rejects missing or cross-origin Origin %s",
    async (origin) => {
      const { send, store } = await setup();
      expect(await send(origin)).toMatchObject({
        status: 403,
        body: { code: "ORIGIN_REQUIRED" },
      });
      expect(store.snapshot().allowHttp).toBe(false);
    },
  );
  it("fails closed if intent audit cannot be persisted", async () => {
    const { send, store } = await setup({ auditFails: true });
    expect((await send()).status).toBe(500);
    expect(store.snapshot().allowHttp).toBe(false);
  });
});
