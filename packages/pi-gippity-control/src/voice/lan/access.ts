import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";

export const LAN_ACCESS_QUERY = "token";
export const DEFAULT_LAN_BIND_HOST = "127.0.0.1";

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

// Tailscale assigns 100.64.0.0/10 and fd7a:115c:a1e0::/48.
const tailnet = new BlockList();
tailnet.addSubnet("100.64.0.0", 10, "ipv4");
tailnet.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/**
 * Returns the address the control server may bind. The server can run Pi
 * methods for any caller that holds the token, so it stays on loopback unless
 * the user opts in to one Tailscale address. Wildcard and LAN binds are refused.
 */
export function resolveLanBindHost(host: string | undefined): string {
	if (host === undefined) return DEFAULT_LAN_BIND_HOST;
	const family = isIP(host);
	const type = family === 6 ? "ipv6" : "ipv4";
	if (family !== 0 && (loopback.check(host, type) || tailnet.check(host, type)))
		return host;
	throw new Error(
		`GipPity will not bind ${JSON.stringify(host)}. Use loopback (the default) or one Tailscale IP address.`,
	);
}

export function isLoopbackHost(host: string): boolean {
	const family = isIP(host);
	return family !== 0 && loopback.check(host, family === 6 ? "ipv6" : "ipv4");
}

export type LanAccessGrant = "cookie" | "header" | "query";

/** One random access token per server start. */
export class LanAccess {
	readonly token = randomBytes(32).toString("base64url");
	private readonly expected = Buffer.from(this.token);

	authorize(request: IncomingMessage, url: URL): LanAccessGrant | undefined {
		if (this.matches(cookieValue(request, this.cookieName(request))))
			return "cookie";
		const authorization = request.headers.authorization;
		if (
			authorization?.startsWith("Bearer ") &&
			this.matches(authorization.slice(7))
		)
			return "header";
		if (this.matches(url.searchParams.get(LAN_ACCESS_QUERY) ?? undefined))
			return "query";
		return undefined;
	}

	/** Browsers share cookies across ports, so the name carries the port. */
	cookieName(request: IncomingMessage): string {
		return `gippity_${request.socket.localPort ?? 0}`;
	}

	setCookie(request: IncomingMessage): string {
		return `${this.cookieName(request)}=${this.token}; Path=/; Secure; HttpOnly; SameSite=Strict`;
	}

	private matches(candidate: string | undefined): boolean {
		if (!candidate) return false;
		const actual = Buffer.from(candidate);
		return (
			actual.byteLength === this.expected.byteLength &&
			timingSafeEqual(actual, this.expected)
		);
	}
}

function cookieValue(
	request: IncomingMessage,
	name: string,
): string | undefined {
	for (const part of request.headers.cookie?.split(";") ?? []) {
		const separator = part.indexOf("=");
		if (separator > 0 && part.slice(0, separator).trim() === name)
			return part.slice(separator + 1).trim();
	}
	return undefined;
}
