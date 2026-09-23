import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { normalizeGippityControlConfig } from "../src/config.ts";
import type { RealtimePeerPlan } from "../src/voice/controller-start.ts";
import { startCodexLanVoiceServer } from "../src/voice/lan/server.ts";

const agentDir = mkdtempSync(join(tmpdir(), "gippity-restart-"));
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

// A voice controller whose call can end outside the LAN server, as /gippity
// stop does, without the plan's onInactive.
function fakeVoice() {
	let current: object | undefined;
	const sent: Buffer[] = [];
	const voice = {
		starts: 0,
		sent,
		inputMuted: false,
		onInputMuteChange: () => () => {},
		setInputMuted: () => true,
		setConversationInputActive() {},
		isCurrentConversation: (session: object) => session === current,
		async startRealtimeWithPeerPlan(
			_ctx: unknown,
			_config: unknown,
			plan: RealtimePeerPlan,
		) {
			voice.starts += 1;
			const conversation = {};
			current = conversation;
			const peer = {
				stopped: false,
				sendAudio(pcm: Buffer) {
					if (conversation !== current)
						throw new Error("Codex voice helper is not running");
					sent.push(pcm);
				},
				isSpeakerSuppressed: false,
			};
			plan.onActive?.(conversation as never, peer as never);
			return true;
		},
		async stopRealtimeWithPeerPlan() {
			current = undefined;
		},
		/** What /gippity stop does to the call. */
		stopOutsideServer() {
			current = undefined;
		},
	};
	return voice;
}

describe("LAN call after the voice call ended elsewhere", () => {
	test("/gippity stop, then a new tap starts a new call", async () => {
		const voice = fakeVoice();
		const server = await startCodexLanVoiceServer({
			ctx: {
				cwd: agentDir,
				isIdle: () => true,
				sessionManager: { getSessionId: () => "owner" },
			} as never,
			pi: {} as never,
			getConfig: () => normalizeGippityControlConfig({}),
			voice: voice as never,
			resolveAuth: () => Promise.reject(new Error("no auth in tests")),
			sendUserMessage: () => {},
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
		try {
			const first = await tap(server);
			expect(first.active).toBe(true);
			first.socket.send(Buffer.alloc(960));
			await pause();
			expect(voice.sent).toHaveLength(1);
			first.socket.close();

			voice.stopOutsideServer();
			const second = await tap(server);
			expect(voice.starts).toBe(2);
			expect(second.active).toBe(true);
			second.socket.send(Buffer.alloc(960));
			await pause();
			expect(voice.sent).toHaveLength(2);
			expect(second.closed).toBeUndefined();
			second.socket.close();
		} finally {
			await server.close();
		}
	});
});

async function tap(server: {
	urls: string[];
	address: { port: number };
}): Promise<{ socket: WebSocket; active: boolean; closed?: string }> {
	const token =
		new URLSearchParams(new URL(server.urls[0] ?? "").hash.slice(1)).get(
			"token",
		) ?? "";
	const origin = `https://localhost:${server.address.port}`;
	// Bun's WebSocket takes its TLS options under "tls".
	const socket = new WebSocket(
		`wss://127.0.0.1:${server.address.port}/api/audio?client=page`,
		["gippity.v1", `gippity.token.${token}`],
		{
			origin,
			headers: { host: `localhost:${server.address.port}`, origin },
			rejectUnauthorized: false,
			tls: { rejectUnauthorized: false },
		} as never,
	);
	const result: { socket: WebSocket; active: boolean; closed?: string } = {
		socket,
		active: false,
	};
	socket.on("close", (_code, reason) => {
		result.closed = reason.toString();
	});
	await new Promise<void>((resolve, reject) => {
		socket.on("open", () => {
			socket.send(JSON.stringify({ type: "start", mode: "conversation" }));
		});
		socket.on("message", (data, isBinary) => {
			if (isBinary) return;
			const message = JSON.parse(String(data));
			if (message.type === "active") {
				result.active = true;
				resolve();
			}
			if (message.type === "error") reject(new Error(message.message));
		});
		socket.on("error", reject);
		setTimeout(() => reject(new Error("no active reply")), 3000);
	});
	return result;
}

function pause(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 50));
}
