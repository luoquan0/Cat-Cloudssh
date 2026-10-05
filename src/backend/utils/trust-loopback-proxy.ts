import { isIP } from "node:net";
import type { Request } from "express";

type TransportRequest = Pick<Request, "secure" | "ip"> &
  Partial<Pick<Request, "headers" | "socket">>;

function normalizeAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  let normalized = address.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (isIP(mapped) === 4) return mapped;
  }
  return normalized;
}

function ipv4Value(address: string): bigint | null {
  if (isIP(address) !== 4) return null;
  let value = 0n;
  for (const part of address.split(".")) {
    value = (value << 8n) | BigInt(Number(part));
  }
  return value;
}

function ipv6Value(address: string): bigint | null {
  if (isIP(address) !== 6) return null;
  const [leftRaw, rightRaw = ""] = address.split("::");
  const expand = (part: string): number[] => {
    if (!part) return [];
    const values: number[] = [];
    for (const segment of part.split(":")) {
      if (segment.includes(".")) {
        const ipv4 = ipv4Value(segment);
        if (ipv4 === null) return [];
        values.push(Number((ipv4 >> 16n) & 0xffffn), Number(ipv4 & 0xffffn));
      } else {
        values.push(Number.parseInt(segment || "0", 16));
      }
    }
    return values;
  };
  const left = expand(leftRaw);
  const right = expand(rightRaw);
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (!address.includes("::") && missing !== 0)) return null;
  const parts = [...left, ...Array(missing).fill(0), ...right];
  if (parts.length !== 8 || parts.some((part) => !Number.isInteger(part))) {
    return null;
  }
  let value = 0n;
  for (const part of parts) value = (value << 16n) | BigInt(part);
  return value;
}

function parsedAddress(address: string | undefined) {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  const version = isIP(normalized);
  if (version === 4) {
    const value = ipv4Value(normalized);
    return value === null ? null : { version: 4, bits: 32, value };
  }
  if (version === 6) {
    const value = ipv6Value(normalized);
    return value === null ? null : { version: 6, bits: 128, value };
  }
  return null;
}

function addressMatchesCidr(
  address: string | undefined,
  cidr: string,
): boolean {
  const parsed = parsedAddress(address);
  if (!parsed) return false;
  const [networkRaw, prefixRaw] = cidr.trim().split("/");
  const network = parsedAddress(networkRaw);
  if (!network || network.version !== parsed.version) return false;
  const prefix =
    prefixRaw === undefined ? parsed.bits : Number.parseInt(prefixRaw, 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) {
    return false;
  }
  if (prefix === 0) return true;
  const shift = BigInt(parsed.bits - prefix);
  return parsed.value >> shift === network.value >> shift;
}

function configuredCidrs(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function environmentEnabled(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? "");
}

export function isAddressAllowedByCidrs(
  address: string | undefined,
  cidrs: string | undefined,
): boolean {
  return configuredCidrs(cidrs).some((cidr) =>
    addressMatchesCidr(address, cidr),
  );
}

export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeAddress(address);
  if (!normalized) return false;
  if (normalized === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim().toLowerCase();
}

function isTrustedProxyPeer(
  address: string | undefined,
  variables: NodeJS.ProcessEnv,
): boolean {
  return (
    isLoopbackAddress(address) ||
    isAddressAllowedByCidrs(address, variables.CLOUDSSH_TRUSTED_PROXY_CIDR)
  );
}

function isSecureTransport(
  request: TransportRequest,
  variables: NodeJS.ProcessEnv,
): boolean {
  const socket = request.socket as
    | (Request["socket"] & { encrypted?: boolean })
    | undefined;
  if (socket?.encrypted === true) return true;

  const remoteAddress = socket?.remoteAddress;
  if (
    remoteAddress &&
    isTrustedProxyPeer(remoteAddress, variables) &&
    firstHeaderValue(request.headers?.["x-forwarded-proto"]) === "https"
  ) {
    return true;
  }

  // Keep lightweight unit-test callers compatible. Real Express requests always
  // provide a socket and therefore use the stricter path above.
  return !socket && request.secure;
}

export function isAdministrativeTransportAllowed(
  request: TransportRequest,
  environment = process.env.NODE_ENV,
  variables: NodeJS.ProcessEnv = process.env,
): boolean {
  if (environment !== "production") return true;
  if (isSecureTransport(request, variables)) return true;

  const sourceAddress = request.ip ?? request.socket?.remoteAddress;
  if (isLoopbackAddress(sourceAddress)) return true;

  if (!environmentEnabled(variables.CLOUDSSH_AGENT_ALLOW_HTTP)) return false;
  if (!variables.CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS?.trim()) return false;

  return isAddressAllowedByCidrs(
    sourceAddress,
    variables.CLOUDSSH_AGENT_HTTP_ALLOWED_CIDRS,
  );
}

export function trustLoopbackProxy(
  address: string,
  hop: number,
  variables: NodeJS.ProcessEnv = process.env,
): boolean {
  if (hop !== 0) return false;
  return isTrustedProxyPeer(address, variables);
}
