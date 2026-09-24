import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { normalizeGippityControlConfig } from "../src/config.ts";
import type { RealtimePeerPlan } from "../src/voice/controller-start.ts";
import type { CodexRealtimePeerEvent } from "../src/voice/conversation/peer.ts";
import { decodeLanVoiceBrowserInput } from "../src/voice/lan/browser-wire.ts";
import { startCodexLanVoiceServer } from "../src/voice/lan/server.ts";

const agentDir = mkdtempSync(join(tmpdir(), "gippity-direct-"));
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

// Drives the peer the way the realtime session does: offer, call setup,
// answer, wait for the data channel, then exchange data-channel messages.
function fakeVoice() {
	const events: CodexRealtimePeerEvent[] = [];
	const state = {
		offers: [] as string[],
		events,
		stops: 0,
		sendData: undefined as ((message: unknown) => void) | undefined,
		running: false,
		/** What /gippity stop does: the controller ends the call and closes its peer. */
		stopOutside: async () => {},
	};
	const voice = {
		inputMuted: false,
		onInputMuteChange: () => () => {},
		setInputMuted: () => true,
		setConversationInputActive() {},
		isCurrentConversation: () => state.running,
		ownsPeerPlan: () => state.running,
		async startRealtimeWithPeerPlan(
			_ctx: unknown,
			config: unknown,
			plan: RealtimePeerPlan,
		) {
			const peer = plan.createPeer();
			const ready = Promise.withResolvers<void>();
			peer.onEvent((event) => {
				events.push(event);
				if (event.type === "state" && event.state === "ready") ready.resolve();
			});
			state.offers.push(await peer.start(config as never));
			peer.applyAnswer("v=0 answer-from-openai");
			await ready.promise;
			state.sendData = (message) => peer.sendData(message);
			state.running = true;
			state.stopOutside = async () => {
				state.running = false;
				await peer.close();
			};
			plan.onActive?.({} as never, peer);
			return true;
		},
		async stopRealtimeWithPeerPlan() {
			state.stops += 1;
		},
	};
	return { voice, state };
}

async function startServer(voice: object, lan: object = {}) {
	return startCodexLanVoiceServer({
		ctx: {
			cwd: agentDir,
			isIdle: () => true,
			sessionManager: { getSessionId: () => "owner" },
		} as never,
		pi: {} as never,
		getConfig: () => normalizeGippityControlConfig({ lan }),
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
}

function openPage(
	server: { urls: string[]; address: { port: number } },
	client: string,
) {
	const token =
		new URLSearchParams(new URL(server.urls[0] ?? "").hash.slice(1)).get(
			"token",
		) ?? "";
	const port = server.address.port;
	const socket = new WebSocket(
		`wss://127.0.0.1:${port}/api/audio?client=${client}`,
		["gippity.v1", `gippity.token.${token}`],
		{
			headers: {
				host: `localhost:${port}`,
				origin: `https://localhost:${port}`,
			},
			tls: { rejectUnauthorized: false },
			rejectUnauthorized: false,
		} as never,
	);
	const received: Array<Record<string, unknown>> = [];
	const waiters: Array<[string, (message: Record<string, unknown>) => void]> =
		[];
	socket.on("message", (data, isBinary) => {
		if (isBinary) return;
		const message = JSON.parse(String(data)) as Record<string, unknown>;
		received.push(message);
		for (const [index, [type, resolve]] of waiters.entries())
			if (message["type"] === type) {
				waiters.splice(index, 1);
				resolve(message);
				break;
			}
	});
	const next = (type: string) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const seen = received.find((message) => message["type"] === type);
			if (seen) {
				received.splice(received.indexOf(seen), 1);
				resolve(seen);
				return;
			}
			waiters.push([type, resolve]);
			setTimeout(() => reject(new Error(`no ${type}`)), 3000);
		});
	const opened = new Promise<void>((resolve, reject) => {
		socket.on("open", () => resolve());
		socket.on("error", reject);
	});
	const send = (value: unknown) => socket.send(JSON.stringify(value));
	return { socket, opened, next, send };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("browser-direct call media", () => {
	test("the page holds the call; the host signals and relays call control", async () => {
		const { voice, state } = fakeVoice();
		const server = await startServer(voice);
		try {
			const page = openPage(server, "page");
			await page.opened;
			page.send({ type: "start", mode: "conversation" });
			await page.next("rtc.offer.request");
			page.send({ type: "rtc.offer", sdp: "v=0 offer-from-browser" });
			expect(await page.next("rtc.answer")).toEqual({
				type: "rtc.answer",
				sdp: "v=0 answer-from-openai",
			});
			page.send({ type: "rtc.state", state: "ready" });
			await page.next("active");
			expect(state.offers).toEqual(["v=0 offer-from-browser"]);

			page.send({
				type: "rtc.data",
				message: { type: "input_transcript.added", item: { text: "hi" } },
			});
			page.send({ type: "rtc.level", input: 0.02, output: 0.4 });
			await pause();
			expect(state.events).toContainEqual({
				type: "data",
				message: { type: "input_transcript.added", item: { text: "hi" } },
			});
			expect(state.events).toContainEqual({
				type: "level",
				input: 0.02,
				output: 0.4,
			});
			expect(state.events).toContainEqual({ type: "playback_activity" });

			state.sendData?.({
				type: "session.context.append",
				channel: "speakable",
			});
			expect(await page.next("rtc.send")).toEqual({
				type: "rtc.send",
				message: { type: "session.context.append", channel: "speakable" },
			});

			// Another page cannot inject call control.
			const other = openPage(server, "other");
			await other.opened;
			other.send({ type: "rtc.data", message: { type: "injected" } });
			await pause();
			expect(state.events).not.toContainEqual({
				type: "data",
				message: { type: "injected" },
			});
			other.socket.close();

			// /gippity stop ends the call outside the server: the page is told.
			await state.stopOutside();
			expect(await page.next("rtc.close")).toEqual({ type: "rtc.close" });
			expect(await page.next("stop")).toEqual({
				type: "stop",
				reason: "ended",
			});

			// The page closes its socket on stop; a new tap opens a new one.
			page.socket.close();
			await pause();
			const again = openPage(server, "page");
			await again.opened;
			again.send({ type: "start", mode: "conversation" });
			await again.next("rtc.offer.request");
			again.send({ type: "rtc.offer", sdp: "v=0 second-offer" });
			await again.next("rtc.answer");
			again.send({ type: "rtc.state", state: "ready" });
			await again.next("active");
			expect(state.offers).toEqual([
				"v=0 offer-from-browser",
				"v=0 second-offer",
			]);

			// The media lives in the page: closing it ends the call.
			again.socket.close();
			await pause();
			await pause();
			expect(state.stops).toBe(1);
		} finally {
			await server.close();
		}
	});
	test("the page learns the media mode; relay stays available", async () => {
		const direct = normalizeGippityControlConfig({});
		expect(direct.lan.media).toBeUndefined();
		expect(
			normalizeGippityControlConfig({ lan: { media: "relay" } }).lan.media,
		).toBe("relay");
		expect(
			normalizeGippityControlConfig({ lan: { media: "nope" } }).lan.media,
		).toBeUndefined();
	});

	test("decodes page call messages and rejects malformed ones", () => {
		const decode = (value: unknown) =>
			decodeLanVoiceBrowserInput(Buffer.from(JSON.stringify(value)), false);
		expect(decode({ type: "rtc.offer", sdp: "v=0 x" })).toEqual({
			type: "control",
			command: { type: "rtc.offer", sdp: "v=0 x" },
		});
		for (const bad of [
			{ type: "rtc.offer", sdp: "not sdp" },
			{ type: "rtc.data", message: [1] },
			{ type: "rtc.state", state: "whatever" },
			{ type: "rtc.unknown" },
		])
			expect(() => decode(bad)).toThrow();
		const big = {
			type: "rtc.data",
			message: { type: "session.updated", text: "x".repeat(200_000) },
		};
		expect(decode(big).type).toBe("control");
		expect(() =>
			decode({ type: "mute", muted: true, pad: "x".repeat(70_000) }),
		).toThrow(/too large/);
	});
});

describe("relayed audio levels", () => {
	test("PCM RMS separates loud from quiet", async () => {
		const { pcmRms } = await import("../src/voice/lan/browser-peer.ts");
		const tone = (amplitude: number) => {
			const pcm = Buffer.alloc(960);
			for (let i = 0; i < 480; i++)
				pcm.writeInt16LE(
					Math.round(Math.sin(i / 5) * amplitude * 32767),
					i * 2,
				);
			return pcm;
		};
		expect(pcmRms(tone(0.5))).toBeCloseTo(0.5 / Math.SQRT2, 1);
		expect(pcmRms(tone(0.01))).toBeLessThan(0.01);
		expect(pcmRms(Buffer.alloc(0))).toBe(0);
	});
});
