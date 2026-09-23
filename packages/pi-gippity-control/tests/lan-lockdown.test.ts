import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { normalizeGippityControlConfig } from "../src/config.ts";
import { resolveCodexVoiceAuth } from "../src/voice/auth.ts";
import { resolveLanBindHost } from "../src/voice/lan/access.ts";
import { lanRemoteCreatePrompt } from "../src/voice/lan/create.ts";
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
	test("listens on loopback and puts the token only in the URL fragment", async () => {
		const { server } = await startTestServer();
		try {
			expect(server.address.address).toBe("127.0.0.1");
			const url = new URL(server.urls[0] ?? "");
			expect(url.origin).toBe(`https://localhost:${server.address.port}`);
			expect(url.pathname).toBe("/");
			expect(url.search).toBe("");
			expect(tokenOf(server).length).toBeGreaterThanOrEqual(43);
		} finally {
			await server.close();
		}
	});

	test("refuses a wildcard bind before it listens", async () => {
		for (const host of ["0.0.0.0", "::", "192.168.1.20"])
			await expect(startTestServer({ host })).rejects.toThrow(/will not bind/);
	});

	test("rejects every API route without the Bearer token", async () => {
		const { server, calls } = await startTestServer();
		try {
			const port = server.address.port;
			const token = tokenOf(server);
			const rpc = { clientId: "a", target: "pi", method: "getThinkingLevel" };
			for (const [method, path, body] of [
				["GET", "/api/discovery", undefined],
				["GET", "/api/events?client=a", undefined],
				["POST", "/api/rpc", rpc],
				["POST", "/api/stop", { clientId: "a" }],
				["POST", "/api/draft", { clientId: "a", text: "x", revision: 0 }],
				["POST", "/api/send", { clientId: "a", text: "x", revision: 0 }],
			] as const) {
				expect((await send(port, method, path, { body })).status).toBe(401);
				const wrong = await send(port, method, path, {
					body,
					headers: { authorization: "Bearer wrong" },
				});
				expect(wrong.status).toBe(401);
				// The old query and cookie forms are not accepted.
				const legacy = await send(
					port,
					method,
					`${path}${path.includes("?") ? "&" : "?"}token=${token}`,
					{
						body,
						headers: { cookie: `gippity_${port}=${token}` },
					},
				);
				expect(legacy.status).toBe(401);
			}
			expect(calls).toEqual([]);
		} finally {
			await server.close();
		}
	});

	test("serves the API with the Bearer token and never sets a cookie", async () => {
		const { server, calls } = await startTestServer();
		try {
			const port = server.address.port;
			const auth = { authorization: `Bearer ${tokenOf(server)}` };
			const discovery = await send(port, "GET", "/api/discovery", {
				headers: auth,
			});
			expect(discovery.status).toBe(200);
			expect(discovery.headers["set-cookie"]).toBeUndefined();
			expect(discovery.headers["referrer-policy"]).toBe("no-referrer");
			const rpc = await send(port, "POST", "/api/rpc", {
				body: { clientId: "a", target: "pi", method: "getThinkingLevel" },
				headers: auth,
			});
			expect(rpc.status).toBe(200);
			expect(calls).toEqual(["getThinkingLevel"]);
			const script = await send(port, "GET", "/_gippity/client.js");
			expect(script.status).toBe(200);
			expect(script.headers["set-cookie"]).toBeUndefined();
			expect(script.headers["referrer-policy"]).toBe("no-referrer");
		} finally {
			await server.close();
		}
	});

	test("rejects foreign Host and cross-origin requests even with the token", async () => {
		const { server, calls } = await startTestServer();
		try {
			const port = server.address.port;
			const auth = { authorization: `Bearer ${tokenOf(server)}` };
			const body = { clientId: "a", target: "pi", method: "getThinkingLevel" };
			for (const host of [`evil.example:${port}`, `localhost:${port + 1}`]) {
				const response = await send(port, "POST", "/api/rpc", {
					body,
					headers: { ...auth, host },
				});
				expect(response.status).toBe(421);
			}
			for (const origin of [
				`https://localhost:${port + 1}`,
				`http://localhost:${port}`,
				"https://evil.example",
				"null",
			]) {
				const response = await send(port, "POST", "/api/rpc", {
					body,
					headers: { ...auth, origin },
				});
				expect(response.status).toBe(403);
			}
			expect(calls).toEqual([]);
			for (const authority of [`localhost:${port}`, `127.0.0.1:${port}`]) {
				const response = await send(port, "POST", "/api/rpc", {
					body,
					headers: { ...auth, host: authority, origin: `https://${authority}` },
				});
				expect(response.status).toBe(200);
			}
		} finally {
			await server.close();
		}
	});

	test("audio WebSocket needs the exact origin and the token", async () => {
		const { server } = await startTestServer();
		try {
			const port = server.address.port;
			const token = tokenOf(server);
			const browser = (origin: string, protocols: string) => ({
				origin,
				"sec-websocket-protocol": protocols,
			});
			const good = `gippity.v1, gippity.token.${token}`;
			const accepted = await upgrade(
				port,
				browser(`https://localhost:${port}`, good),
			);
			expect(accepted.status).toBe(101);
			expect(accepted.head).toMatch(/sec-websocket-protocol: gippity\.v1\r\n/i);
			expect(accepted.head).not.toContain(token);
			for (const headers of [
				{},
				browser(`https://localhost:${port}`, "gippity.v1"),
				browser(`https://localhost:${port}`, "gippity.v1, gippity.token.wrong"),
				// Same site, different port: a page on another localhost service.
				browser(`https://localhost:${port + 1}`, good),
				browser("null", good),
				browser("https://evil.example", good),
				// A page cannot set Authorization; a browser Origin needs the subprotocol.
				{
					origin: `https://localhost:${port}`,
					authorization: `Bearer ${token}`,
				},
				{
					...browser(`https://localhost:${port}`, good),
					host: `evil.example:${port}`,
				},
			])
				expect((await upgrade(port, headers)).status).toBe(401);
			// Native clients (no Origin) authenticate with a Bearer header.
			const native = await upgrade(port, {
				authorization: `Bearer ${token}`,
				"sec-websocket-protocol": "gippity.v1",
			});
			expect(native.status).toBe(101);
			expect(
				(await upgrade(port, { authorization: "Bearer wrong" })).status,
			).toBe(401);
		} finally {
			await server.close();
		}
	});

	test("custom app files are static; the discovery fallback needs the token", async () => {
		const appDir = mkdtempSync(join(agentDir, "app-"));
		const withIndex = await startTestServer(
			{ customWebApp: true, customWebAppPath: appDir },
			() => writeFileSync(join(appDir, "index.html"), "<p>app</p>"),
		);
		try {
			const port = withIndex.server.address.port;
			const page = await send(port, "GET", "/");
			expect(page.status).toBe(200);
			expect(page.headers["referrer-policy"]).toBe("no-referrer");
		} finally {
			await withIndex.server.close();
		}
		rmSync(join(appDir, "index.html"));
		const fallback = await startTestServer({
			customWebApp: true,
			customWebAppPath: appDir,
		});
		try {
			const port = fallback.server.address.port;
			expect((await send(port, "GET", "/")).status).toBe(401);
			const authorized = await send(port, "GET", "/", {
				headers: { authorization: `Bearer ${tokenOf(fallback.server)}` },
			});
			expect(authorized.status).toBe(200);
		} finally {
			await fallback.server.close();
		}
	});

	test("uses a fresh token for each server", async () => {
		const first = await startTestServer();
		const second = await startTestServer();
		try {
			expect(tokenOf(first.server)).not.toBe(tokenOf(second.server));
			const stale = await send(
				second.server.address.port,
				"GET",
				"/api/discovery",
				{ headers: { authorization: `Bearer ${tokenOf(first.server)}` } },
			);
			expect(stale.status).toBe(401);
		} finally {
			await Promise.all([first.server.close(), second.server.close()]);
		}
	});

	test("the create prompt carries discovery data but never the token", async () => {
		const { server } = await startTestServer();
		try {
			const prompt = lanRemoteCreatePrompt({
				appDirectory: agentDir,
				configPath: join(agentDir, "pi-gippity-control.json"),
				discovery: server.discovery(),
			});
			expect(prompt).toContain('"protocolVersion"');
			expect(prompt).not.toContain(tokenOf(server));
			expect(prompt).not.toContain(String(server.address.port));
			expect(prompt).not.toMatch(/curl|-k\b/);
		} finally {
			await server.close();
		}
	});
});

describe("remote RPC allowlist", () => {
	test("refuses exec, key readers and dotted paths even with the token", async () => {
		const { server, calls } = await startTestServer();
		try {
			const port = server.address.port;
			const auth = { authorization: `Bearer ${tokenOf(server)}` };
			const call = async (target: string, method: string) =>
				(
					await send(port, "POST", "/api/rpc", {
						body: { clientId: "a", target, method, args: ["id"] },
						headers: auth,
					})
				).json;
			for (const [target, method] of [
				["pi", "exec"],
				["pi", "sendUserMessage"],
				["pi", "setActiveTools"],
				["pi", "registerProvider"],
				["context", "shutdown"],
				["context", "modelRegistry.getProviderAuth"],
				["context", "sessionManager.getSessionFile"],
			] as const) {
				const response = (await call(target, method)) as {
					ok?: boolean;
					error?: { message?: string };
				};
				expect(response.ok).toBe(false);
				expect(String(response.error?.message)).toContain("not allowed");
			}
			expect(calls).toEqual([]);
			expect(await call("pi", "getThinkingLevel")).toMatchObject({
				ok: true,
				result: "high",
			});
		} finally {
			await server.close();
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

function tokenOf(server: CodexLanVoiceServer): string {
	const fragment = new URL(server.urls[0] ?? "").hash.slice(1);
	return new URLSearchParams(fragment).get("token") ?? "";
}

async function startTestServer(
	lan: Record<string, unknown> = {},
	beforeStart?: () => void,
): Promise<{ server: CodexLanVoiceServer; calls: string[] }> {
	beforeStart?.();
	const calls: string[] = [];
	const pi = {
		getThinkingLevel: () => {
			calls.push("getThinkingLevel");
			return "high";
		},
		exec: () => {
			calls.push("exec");
		},
		sendUserMessage: () => {
			calls.push("sendUserMessage");
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
): Promise<{
	status: number;
	headers: Record<string, unknown>;
	json: unknown;
}> {
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
					host: `localhost:${port}`,
					...(body ? { "content-type": "application/json" } : {}),
					...options.headers,
				},
			},
			(response) => {
				const isStream = String(response.headers["content-type"]).includes(
					"event-stream",
				);
				const done = (text: string) =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						json: parseJson(text),
					});
				if (isStream) {
					response.destroy();
					done("");
					return;
				}
				let text = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					text += chunk;
				});
				response.on("end", () => done(text));
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function upgrade(
	port: number,
	headers: Record<string, string>,
): Promise<{ status: number; head: string }> {
	return new Promise((resolve, reject) => {
		const all: Record<string, string> = {
			host: `localhost:${port}`,
			connection: "Upgrade",
			upgrade: "websocket",
			"sec-websocket-version": "13",
			"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			...headers,
		};
		const socket = connect(
			{ host: "127.0.0.1", port, rejectUnauthorized: false },
			() => {
				socket.write(
					[
						"GET /api/audio?client=a HTTP/1.1",
						...Object.entries(all).map(([name, value]) => `${name}: ${value}`),
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
			const end = head.indexOf("\r\n\r\n");
			if (end < 0) return;
			const match = /^HTTP\/1\.1 (\d{3})/.exec(head);
			resolve({
				status: Number(match?.[1] ?? 0),
				head: head.slice(0, end + 2),
			});
			socket.destroy();
		});
		socket.on("error", reject);
		socket.on("close", () => resolve({ status: 0, head }));
	});
}
