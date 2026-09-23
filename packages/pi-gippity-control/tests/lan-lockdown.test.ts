import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { normalizeGippityControlConfig } from "../src/config.ts";
import { resolveCodexVoiceAuth } from "../src/voice/auth.ts";
import { resolveLanBindHost } from "../src/voice/lan/access.ts";
import {
	type CodexLanVoiceServer,
	startCodexLanVoiceServer,
} from "../src/voice/lan/server.ts";

const agentDir = mkdtempSync(join(tmpdir(), "gippity-lockdown-"));
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

describe("LAN bind policy", () => {
	test("binds loopback unless a host is configured", () => {
		expect(resolveLanBindHost(undefined)).toBe("127.0.0.1");
	});

	test("accepts loopback and Tailscale addresses only", () => {
		for (const host of [
			"127.0.0.1",
			"::1",
			"100.101.102.103",
			"fd7a:115c:a1e0::1",
		])
			expect(resolveLanBindHost(host)).toBe(host);
		for (const host of [
			"0.0.0.0",
			"::",
			"192.168.1.20",
			"10.0.0.5",
			"100.128.0.1",
			"dev1.local",
			"",
		])
			expect(() => resolveLanBindHost(host)).toThrow(/will not bind/);
	});
});

describe("LAN server lockdown", () => {
	test("listens on loopback by default and prints a token URL", async () => {
		const { server } = await startTestServer();
		try {
			expect(server.address.address).toBe("127.0.0.1");
			const url = new URL(server.urls[0] ?? "");
			expect(url.hostname).toBe("localhost");
			expect(url.searchParams.get("token")?.length).toBeGreaterThanOrEqual(43);
		} finally {
			await server.close();
		}
	});

	test("refuses a wildcard bind before it listens", async () => {
		for (const host of ["0.0.0.0", "::", "192.168.1.20"])
			await expect(startTestServer({ host })).rejects.toThrow(/will not bind/);
	});

	test("rejects every API route without the token", async () => {
		const { server, calls } = await startTestServer();
		try {
			const port = server.address.port;
			expect((await send(port, "GET", "/")).status).toBe(401);
			expect((await send(port, "GET", "/api/discovery")).status).toBe(401);
			expect((await send(port, "GET", "/_gippity/client.js")).status).toBe(401);
			expect((await send(port, "GET", "/api/events?client=a")).status).toBe(
				401,
			);
			const rpc = await send(port, "POST", "/api/rpc", {
				body: { clientId: "a", target: "pi", method: "exec", args: ["id"] },
			});
			expect(rpc.status).toBe(401);
			const wrong = await send(port, "POST", "/api/rpc", {
				body: { clientId: "a", target: "pi", method: "exec", args: ["id"] },
				headers: {
					authorization: "Bearer wrong",
					cookie: `gippity_${port}=wrong`,
				},
			});
			expect(wrong.status).toBe(401);
			expect(calls).toEqual([]);
			expect(await upgradeStatus(port, "")).toBe(401);
		} finally {
			await server.close();
		}
	});

	test("swaps the URL token for a strict cookie and then serves the API", async () => {
		const { server, calls } = await startTestServer();
		try {
			const port = server.address.port;
			const token =
				new URL(server.urls[0] ?? "").searchParams.get("token") ?? "";
			const entry = await send(port, "GET", `/?token=${token}`);
			expect(entry.status).toBe(303);
			expect(entry.headers.location).toBe("/");
			const cookie = String(entry.headers["set-cookie"]);
			expect(cookie).toContain(`gippity_${port}=${token}`);
			expect(cookie).toContain("HttpOnly");
			expect(cookie).toContain("Secure");
			expect(cookie).toContain("SameSite=Strict");
			const cookieHeader = { cookie: `other=1; gippity_${port}=${token}` };
			expect(
				(await send(port, "GET", "/api/discovery", { headers: cookieHeader }))
					.status,
			).toBe(200);
			expect(
				(
					await send(port, "GET", "/api/discovery", {
						headers: { authorization: `Bearer ${token}` },
					})
				).status,
			).toBe(200);
			expect(
				(
					await send(
						port,
						"GET",
						new URL(server.discoveryUrl).pathname +
							new URL(server.discoveryUrl).search,
					)
				).status,
			).toBe(200);
			const rpc = await send(port, "POST", "/api/rpc", {
				body: { clientId: "a", target: "pi", method: "probe", args: [] },
				headers: cookieHeader,
			});
			expect(rpc.status).toBe(200);
			expect(calls).toEqual(["probe"]);
			expect(await upgradeStatus(port, cookieHeader.cookie)).toBe(101);
		} finally {
			await server.close();
		}
	});

	test("uses a fresh token for each server", async () => {
		const first = await startTestServer();
		const second = await startTestServer();
		try {
			const token = (server: CodexLanVoiceServer) =>
				new URL(server.urls[0] ?? "").searchParams.get("token");
			expect(token(first.server)).not.toBe(token(second.server));
			const port = second.server.address.port;
			const stale = await send(port, "GET", "/api/discovery", {
				headers: { authorization: `Bearer ${token(first.server)}` },
			});
			expect(stale.status).toBe(401);
		} finally {
			await Promise.all([first.server.close(), second.server.close()]);
		}
	});
});

describe("realtime auth through a gateway provider", () => {
	test("uses the provider key and base URL without a ChatGPT account", async () => {
		const requested: string[] = [];
		const ctx = {
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: {
				async getProviderAuth(provider: string) {
					requested.push(provider);
					return { auth: { apiKey: "gateway-key", headers: {} } };
				},
				getAll: () => [
					{ provider: "other", baseUrl: "https://other.example/v1" },
					{ provider: "cliproxyapi", baseUrl: "https://gateway.example/v1" },
				],
			},
		};
		const auth = await resolveCodexVoiceAuth(ctx as never, "cliproxyapi");
		expect(requested).toEqual(["cliproxyapi"]);
		expect(auth.baseUrl).toBe("https://gateway.example/v1");
		expect(auth.officialCodex).toBe(false);
		expect(auth.headers.get("authorization")).toBe("Bearer gateway-key");
		expect(auth.headers.has("chatgpt-account-id")).toBe(false);
	});

	test("reports a provider without a key", async () => {
		const ctx = {
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry: {
				getProviderAuth: async () => undefined,
				getAll: () => [],
			},
		};
		await expect(
			resolveCodexVoiceAuth(ctx as never, "cliproxyapi"),
		).rejects.toThrow(/no API key/);
	});

	test("keeps the provider in saved config", () => {
		const config = normalizeGippityControlConfig({
			lan: { host: "100.100.1.2" },
			voice: { provider: "cliproxyapi" },
		});
		expect(config.voice.provider).toBe("cliproxyapi");
		expect(config.lan.host).toBe("100.100.1.2");
	});
});

async function startTestServer(lan: Record<string, unknown> = {}): Promise<{
	server: CodexLanVoiceServer;
	calls: string[];
}> {
	const calls: string[] = [];
	const probe = () => {
		calls.push("probe");
		return "ok";
	};
	const pi = {
		probe,
		exec: () => {
			calls.push("exec");
		},
	};
	const server = await startCodexLanVoiceServer({
		ctx: {
			cwd: agentDir,
			isIdle: () => true,
			sessionManager: { getSessionId: () => "owner" },
		} as never,
		pi: pi as never,
		getConfig: () => normalizeGippityControlConfig({ lan }),
		voice: {
			inputMuted: false,
			onInputMuteChange: () => () => {},
		} as never,
		resolveAuth: () => Promise.reject(new Error("no auth in tests")),
		sendUserMessage: () => {
			calls.push("sendUserMessage");
		},
		ownerSessionId: "owner",
		port: 0,
		certificateAgentDir: agentDir,
		remoteApps: {
			apps: () => [],
			onMessage: () => () => {},
			snapshot: () => undefined,
			route: () => ({ kind: "none" }),
		} as never,
	});
	return { server, calls };
}

function send(
	port: number,
	method: string,
	path: string,
	options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, unknown> }> {
	return new Promise((resolve, reject) => {
		const body =
			options.body === undefined ? undefined : JSON.stringify(options.body);
		const req = request(
			{
				host: "127.0.0.1",
				port,
				method,
				path,
				rejectUnauthorized: false,
				headers: {
					...(body ? { "content-type": "application/json" } : {}),
					...options.headers,
				},
			},
			(response) => {
				response.resume();
				response.destroy();
				resolve({
					status: response.statusCode ?? 0,
					headers: response.headers,
				});
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

function upgradeStatus(port: number, cookie: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = connect(
			{ host: "127.0.0.1", port, rejectUnauthorized: false },
			() => {
				socket.write(
					[
						"GET /api/audio?client=a HTTP/1.1",
						`Host: localhost:${port}`,
						"Connection: Upgrade",
						"Upgrade: websocket",
						"Sec-WebSocket-Version: 13",
						"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
						...(cookie ? [`Cookie: ${cookie}`] : []),
						"",
						"",
					].join("\r\n"),
				);
			},
		);
		let head = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			head += chunk;
			const match = /^HTTP\/1\.1 (\d{3})/.exec(head);
			if (match) {
				resolve(Number(match[1]));
				socket.destroy();
			}
		});
		socket.on("error", reject);
		socket.on("close", () => resolve(0));
	});
}
