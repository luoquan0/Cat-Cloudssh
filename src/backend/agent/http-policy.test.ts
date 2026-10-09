import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentHttpPolicyStore,
  validateAgentHttpPolicy,
} from "./http-policy.js";
import {
  isAgentTransportAllowed,
  isAdministrativeTransportAllowed,
  setAgentHttpPolicyProvider,
} from "../utils/trust-loopback-proxy.js";

afterEach(() => setAgentHttpPolicyProvider(undefined));
function database() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT)");
  return db;
}
describe("Agent LAN HTTP policy", () => {
  it.each([
    "0.0.0.0/0",
    "192.168.0.0/8",
    "203.0.113.1/32",
    "192.168.1.1/24abc",
    "::/0",
    "2001:db8::/32",
  ])("rejects broad, public or invalid range %s", (cidr) => {
    expect(() =>
      validateAgentHttpPolicy({ allowHttp: true, allowedCidrs: [cidr] }),
    ).toThrow();
  });
  it("requires an explicit nonempty source list", () => {
    expect(() =>
      validateAgentHttpPolicy({ allowHttp: true, allowedCidrs: [] }),
    ).toThrow();
    expect(
      validateAgentHttpPolicy({
        allowHttp: true,
        allowedCidrs: ["192.168.222.10"],
      }).allowedCidrs,
    ).toEqual(["192.168.222.10/32"]);
  });
  it("persists across store recreation and takes effect without touching other admin policies", async () => {
    const db = database();
    const store = new AgentHttpPolicyStore(db, async () => {}, {});
    await store.update(
      { allowHttp: true, allowedCidrs: ["192.168.222.0/24"] },
      async () => {},
    );
    const restored = new AgentHttpPolicyStore(db, async () => {}, {});
    setAgentHttpPolicyProvider(() => restored.snapshot());
    const req = { secure: false, ip: "192.168.222.10" };
    expect(isAgentTransportAllowed(req, "production", {})).toBe(true);
    expect(isAdministrativeTransportAllowed(req, "production", {})).toBe(false);
    expect(
      isAgentTransportAllowed(
        { secure: false, ip: "203.0.113.1" },
        "production",
        {},
      ),
    ).toBe(false);
    db.close();
  });
  it("does not publish failed writes or audit failures", async () => {
    const db = database();
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk error"))
      .mockResolvedValue(undefined);
    const store = new AgentHttpPolicyStore(db, persist, {});
    await expect(
      store.update(
        { allowHttp: true, allowedCidrs: ["10.0.0.1/32"] },
        async () => {},
      ),
    ).rejects.toThrow("disk error");
    expect(store.snapshot().allowHttp).toBe(false);
    await expect(
      store.update(
        { allowHttp: true, allowedCidrs: ["10.0.0.1/32"] },
        async () => {
          throw new Error("audit error");
        },
      ),
    ).rejects.toThrow("audit error");
    expect(db.prepare("SELECT * FROM settings").all()).toEqual([]);
    db.close();
  });
  it("honors an explicitly locked deployment", async () => {
    const db = database();
    const store = new AgentHttpPolicyStore(db, async () => {}, {
      CLOUDSSH_AGENT_HTTP_POLICY_LOCKED: "true",
    });
    await expect(
      store.update(
        { allowHttp: true, allowedCidrs: ["10.0.0.1/32"] },
        async () => {},
      ),
    ).rejects.toThrow("锁定");
    db.close();
  });
});
