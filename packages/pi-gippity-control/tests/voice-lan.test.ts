import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { WebSocket } from "ws";
import { LanVoiceBrowserClients } from "../src/voice/lan/browser-clients.ts";
import {
	handleLanVoiceHttpRequest,
	type LanVoiceHttpHandlers,
} from "../src/voice/lan/http-handler.ts";
import { decodeLanVoiceAudioCommand } from "../src/voice/lan/protocol.ts";

describe("LAN conversation setup", () => {
	test("rejects browser-owned peer messages", () => {
		expect(() =>
			decodeLanVoiceAudioCommand({ type: "peer_state", state: "ready" }),
		).toThrow();
	});

	test("preserves device handoff and restarts after explicit release", async () => {
		let hostStarts = 0;
		let hostConversation: object | undefined;
		const clients = testBrowserClients({
			async ensureConversation() {
				if (!hostConversation) {
					hostConversation = {};
					hostStarts += 1;
				}
			},
			onConversationActivity(active) {
				if (!active) hostConversation = undefined;
			},
		});
		const first = new TestWebSocket();
		clients.connectAudio("first", first.asWebSocket());
		first.receive({ type: "start", mode: "conversation" });
		await settle();
		first.close();
		await settle();
		const second = new TestWebSocket();
		clients.connectAudio("second", second.asWebSocket());
		second.receive({ type: "start", mode: "conversation" });
		await settle();
		expect(hostStarts).toBe(1);
		expect(
			second.sent.map((value) => JSON.parse(String(value))).at(-1),
		).toEqual({
			type: "active",
			mode: "conversation",
			muted: false,
			speakerSuppressed: false,
		});
		second.receive({ type: "release" });
		await settle();
		second.receive({ type: "start", mode: "conversation" });
		await settle();
		expect(hostStarts).toBe(2);
		await clients.close();
	});

	test("takeover shares the pending host conversation setup", async () => {
		const setup = Promise.withResolvers<void>();
		let hostStarts = 0;
		let sharedSetup: Promise<void> | undefined;
		const clients = testBrowserClients({
			ensureConversation() {
				if (!sharedSetup) {
					hostStarts += 1;
					sharedSetup = setup.promise;
				}
				return sharedSetup;
			},
		});
		const first = new TestWebSocket();
		clients.connectAudio("first", first.asWebSocket());
		first.receive({ type: "start", mode: "conversation" });
		await settle();
		const second = new TestWebSocket();
		clients.connectAudio("second", second.asWebSocket());
		second.receive({ type: "start", mode: "conversation" });
		setup.resolve();
		await settle();
		await settle();
		expect(hostStarts).toBe(1);
		expect(first.readyState).toBe(WebSocket.CLOSED);
		expect(
			second.sent.map((value) => JSON.parse(String(value))).at(-1),
		).toEqual({
			type: "active",
			mode: "conversation",
			muted: false,
			speakerSuppressed: false,
		});
		await clients.close();
	});

	test("reports startup errors without a terminal stop racing them", async () => {
		const clients = testBrowserClients({
			async ensureConversation() {
				throw new Error("authentication failed");
			},
		});
		const socket = new TestWebSocket();
		clients.connectAudio("first", socket.asWebSocket());
		socket.receive({ type: "start", mode: "conversation" });
		await settle();
		expect(socket.sent.map((value) => JSON.parse(String(value)))).toEqual([
			{ type: "connected" },
			{ type: "error", message: "authentication failed" },
		]);
		await clients.close();
	});
});

describe("terminating stop confirms the end", () => {
	for (const outcome of ["resolve", "reject"] as const)
		test(`waits for the conversation to end (${outcome})`, async () => {
			const ending = Promise.withResolvers<void>();
			const clients = testBrowserClients({
				async ensureConversation() {},
				onConversationActivity: (active) =>
					active ? undefined : ending.promise,
			});
			const socket = new TestWebSocket();
			clients.connectAudio("code-1", socket.asWebSocket());
			socket.receive({ type: "start", mode: "conversation" });
			await settle();
			const replies: Array<{ status: number; body: unknown }> = [];
			const stop = handleLanVoiceHttpRequest(
				stopRequest("code-1"),
				recordResponse(replies),
				stopHandlers(clients),
			);
			await settle();
			expect(replies).toEqual([]);
			if (outcome === "resolve") ending.resolve();
			else ending.reject(new Error("helper did not stop"));
			await stop;
			expect(replies).toEqual(
				outcome === "resolve"
					? [{ status: 200, body: { ok: true, ended: true } }]
					: [{ status: 500, body: { error: "helper did not stop" } }],
			);
			await clients.close();
		});

	test("a retry after a failed end ends the call instead of reporting it ended", async () => {
		let attempts = 0;
		const clients = testBrowserClients({
			async ensureConversation() {},
			onConversationActivity: (active) => {
				if (active) return undefined;
				attempts += 1;
				return attempts === 1
					? Promise.reject(new Error("helper did not stop"))
					: Promise.resolve();
			},
		});
		const socket = new TestWebSocket();
		clients.connectAudio("code-1", socket.asWebSocket());
		socket.receive({ type: "start", mode: "conversation" });
		await settle();
		const replies: Array<{ status: number; body: unknown }> = [];
		for (let i = 0; i < 2; i++)
			await handleLanVoiceHttpRequest(
				stopRequest("code-1"),
				recordResponse(replies),
				stopHandlers(clients),
			);
		expect(replies).toEqual([
			{ status: 500, body: { error: "helper did not stop" } },
			{ status: 200, body: { ok: true, ended: true } },
		]);
		expect(attempts).toBe(2);
		await clients.close();
	});

	test("a client that owns no conversation is ended at once", async () => {
		const clients = testBrowserClients({ async ensureConversation() {} });
		const replies: Array<{ status: number; body: unknown }> = [];
		await handleLanVoiceHttpRequest(
			stopRequest("nobody"),
			recordResponse(replies),
			stopHandlers(clients),
		);
		expect(replies).toEqual([{ status: 200, body: { ok: true, ended: true } }]);
		await clients.close();
	});
});

function stopRequest(clientId: string): IncomingMessage {
	const request = Readable.from([
		Buffer.from(JSON.stringify({ clientId, terminateConversation: true })),
	]) as unknown as IncomingMessage;
	Object.assign(request, {
		method: "POST",
		url: "/api/stop",
		headers: {
			host: "127.0.0.1:43120",
			"content-type": "application/json",
			authorization: "Bearer t",
		},
	});
	return request;
}

function recordResponse(
	replies: Array<{ status: number; body: unknown }>,
): ServerResponse {
	let status = 0;
	return {
		headersSent: false,
		setHeader() {},
		writeHead(code: number) {
			status = code;
		},
		end(body: string) {
			replies.push({ status, body: JSON.parse(body) });
		},
	} as unknown as ServerResponse;
}

function stopHandlers(clients: LanVoiceBrowserClients) {
	return {
		access: {
			hostAllowed: () => true,
			originAllowed: () => true,
			bearer: () => true,
		},
		clients,
		ownerIsActive: () => true,
		closing: false,
		webApp: () => ({ customWebApp: false, discovery: {} }),
	} as unknown as LanVoiceHttpHandlers;
}

function testBrowserClients(overrides: {
	ensureConversation(): Promise<void>;
	onConversationActivity?(active: boolean): void | Promise<void>;
}): LanVoiceBrowserClients {
	return new LanVoiceBrowserClients({
		...overrides,
		startDictation: async () => {},
		finishDictation: async () => {},
		cancelDictation: async () => {},
		onConversationActivity: overrides.onConversationActivity ?? (() => {}),
		onConversationMute: () => {},
		conversationMuted: () => false,
		onConversationInputTooQuiet: () => {},
		onConversationAudio: () => {},
		onDictationAudio: () => {},
	});
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

class TestWebSocket extends EventEmitter {
	readyState: number = WebSocket.OPEN;
	bufferedAmount = 0;
	readonly sent: Array<string | Buffer> = [];

	asWebSocket(): WebSocket {
		return this as unknown as WebSocket;
	}

	send(value: string | Buffer): void {
		this.sent.push(value);
	}

	receive(value: unknown): void {
		this.emit("message", Buffer.from(JSON.stringify(value)), false);
	}

	close(code = 1000, reason = "closed"): void {
		if (this.readyState === WebSocket.CLOSED) return;
		this.readyState = WebSocket.CLOSED;
		this.emit("close", code, Buffer.from(reason));
	}

	terminate(): void {
		this.close(1006, "terminated");
	}
}
