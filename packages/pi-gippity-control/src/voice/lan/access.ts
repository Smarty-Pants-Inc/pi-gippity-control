import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { BlockList, isIP, isIPv6 } from "node:net";

/** URL fragment key; browsers never send fragments to the server. */
export const LAN_ACCESS_FRAGMENT = "token";
/** Audio WebSocket subprotocol; the token travels in a second subprotocol. */
export const LAN_AUDIO_SUBPROTOCOL = "gippity.v1";
const TOKEN_SUBPROTOCOL_PREFIX = "gippity.token.";
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

/**
 * Origin-bound access for one server start. The token is sent only as an
 * `Authorization: Bearer` header or an audio WebSocket subprotocol, never as a
 * cookie: cookies are shared by every port on a host, so any other localhost
 * service would receive them.
 */
export class LanAccess {
	readonly token = randomBytes(32).toString("base64url");
	private readonly expected = Buffer.from(this.token);
	private readonly hosts = new Set<string>();
	private readonly origins = new Set<string>();

	/** Allows only the authorities that reach this listener. */
	bind(address: string, port: number): void {
		const names = isLoopbackHost(address)
			? ["localhost", "127.0.0.1", "[::1]"]
			: [isIPv6(address) ? `[${address}]` : address];
		for (const name of names) {
			this.hosts.add(`${name}:${port}`);
			this.origins.add(`https://${name}:${port}`);
		}
	}

	/** Rejects foreign Host headers (DNS rebinding, wrong forwards). */
	hostAllowed(request: IncomingMessage): boolean {
		return this.hosts.has(request.headers.host ?? "");
	}

	/** A present Origin must be this server; `required` also rejects a missing one. */
	originAllowed(request: IncomingMessage, required: boolean): boolean {
		const origin = request.headers.origin;
		if (origin === undefined) return !required;
		return this.origins.has(origin);
	}

	bearer(request: IncomingMessage): boolean {
		const authorization = request.headers.authorization;
		return (
			authorization?.startsWith("Bearer ") === true &&
			this.matches(authorization.slice(7))
		);
	}

	/**
	 * Browser upgrades need this exact Origin plus the token subprotocol. A
	 * native client (for example the Code gateway) sends no Origin and a Bearer
	 * header; browsers always send Origin on WebSocket upgrades and cannot set
	 * Authorization, so no page can take that path.
	 */
	upgrade(request: IncomingMessage): boolean {
		if (!this.hostAllowed(request)) return false;
		if (request.headers.origin === undefined) return this.bearer(request);
		if (!this.originAllowed(request, true)) return false;
		const protocols = (request.headers["sec-websocket-protocol"] ?? "")
			.split(",")
			.map((value) => value.trim());
		const token = protocols
			.find((value) => value.startsWith(TOKEN_SUBPROTOCOL_PREFIX))
			?.slice(TOKEN_SUBPROTOCOL_PREFIX.length);
		return protocols.includes(LAN_AUDIO_SUBPROTOCOL) && this.matches(token);
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
