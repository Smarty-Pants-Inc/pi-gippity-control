import type { ServerResponse } from "node:http";
import { type RawData, WebSocket } from "ws";
import { LanVoiceBrowserConnections } from "./browser-connections.ts";
import {
	type LanVoiceBrowserClientsOptions,
	LanVoiceBrowserSession,
} from "./browser-session.ts";
import { decodeLanVoiceBrowserInput, errorMessage } from "./browser-wire.ts";
import type { LanVoiceRtcCommand } from "./protocol.ts";

export {
	MAX_AUDIO_SOCKET_BYTES,
	MAX_CONTROL_BYTES,
} from "./browser-wire.ts";

export class LanVoiceBrowserClients {
	private readonly connections = new LanVoiceBrowserConnections();
	private readonly session: LanVoiceBrowserSession;

	private readonly options: LanVoiceBrowserClientsOptions;

	constructor(options: LanVoiceBrowserClientsOptions) {
		this.options = options;
		this.session = new LanVoiceBrowserSession(options, this.connections);
	}

	sendConversationControl(message: unknown): boolean {
		return this.session.sendConversationControl(message);
	}

	connectEvents(clientId: string, response: ServerResponse): void {
		this.connections.connectEvents(clientId, response, this.session.closed);
	}

	connectAudio(clientId: string, socket: WebSocket): void {
		this.connections.connectAudio(clientId, socket, this.session.closed, {
			onMessage: (data, isBinary) =>
				this.receive(clientId, socket, data, isBinary),
			onReplaced: (previous) =>
				this.session.releaseStarting(clientId, previous),
			// Browser-direct media lives in the page, so its closing ends the call.
			onClose: () =>
				this.session
					.release(clientId, socket, this.session.directMedia)
					.catch(() => {}),
		});
	}

	sendControl(clientId: string, value: unknown): void {
		this.connections.sendControl(clientId, value);
	}

	hasEventClients(): boolean {
		return this.connections.hasEventClients();
	}

	broadcastControl(value: unknown): void {
		this.connections.broadcastControl(value);
	}

	sendConversationAudio(pcm: Buffer): void {
		this.session.sendConversationAudio(pcm);
	}

	setConversationSpeakerSuppressed(suppressed: boolean): void {
		this.session.setConversationSpeakerSuppressed(suppressed);
	}

	resetConversationInputLevel(): void {
		this.session.resetConversationInputLevel();
	}

	release(
		clientId: string,
		socket?: WebSocket,
		terminateConversation = false,
	): Promise<void> {
		return this.session.release(clientId, socket, terminateConversation);
	}

	heartbeat(): void {
		this.connections.heartbeat();
	}

	async close(): Promise<void> {
		await this.session.close();
	}

	private receive(
		clientId: string,
		socket: WebSocket,
		data: RawData,
		isBinary: boolean,
	): void {
		if (!this.connections.isCurrentAudio(clientId, socket)) return;
		let input: ReturnType<typeof decodeLanVoiceBrowserInput>;
		try {
			input = decodeLanVoiceBrowserInput(data, isBinary);
		} catch {
			socket.close(1003, "invalid message");
			return;
		}
		// A failing handler is not a malformed message: report its real error.
		try {
			if (input.type === "audio") {
				this.session.receiveAudio(clientId, socket, input.pcm);
				return;
			}
			const message = input.command;
			if (message.type.startsWith("rtc.")) {
				if (socket === this.session.conversationSocket())
					this.options.onRtcMessage?.(message as LanVoiceRtcCommand);
				return;
			}
			if (message.type === "start") {
				void this.session
					.claim(clientId, socket, message.mode)
					.catch((error: unknown) => this.sendSocketError(socket, error));
			} else if (message.type === "finish") {
				void this.session
					.finish(
						clientId,
						socket,
						message.draft,
						message.revision,
						message.selection,
					)
					.catch((error: unknown) => this.sendSocketError(socket, error));
			} else if (message.type === "release") {
				this.session.release(clientId, socket, true);
			} else if (message.type === "mute") {
				this.session.mute(clientId, socket, message.muted);
			} else {
				void this.session
					.cancelDictation(clientId)
					.catch((error: unknown) => this.sendSocketError(socket, error));
			}
		} catch (error) {
			this.sendSocketError(socket, error);
		}
	}

	private sendSocketError(socket: WebSocket, error: unknown): void {
		if (socket.readyState === WebSocket.OPEN)
			socket.send(
				JSON.stringify({ type: "error", message: errorMessage(error) }),
			);
	}
}
