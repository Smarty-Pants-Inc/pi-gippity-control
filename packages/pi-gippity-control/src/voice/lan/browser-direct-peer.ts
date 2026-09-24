import type { GippityControlConfig } from "../../config.ts";
import type {
	CodexRealtimePeerEvent,
	CodexRealtimeWebRtcPeer,
} from "../conversation/peer.ts";
import type { LanVoiceRtcCommand } from "./protocol.ts";

const OFFER_TIMEOUT_MS = 20_000;

/**
 * A realtime peer whose media runs in the browser page. The page holds the
 * RTCPeerConnection to OpenAI, so call audio never crosses the host or the
 * tunnel. The host keeps signaling and all call control: data-channel
 * messages travel as small JSON over the page's audio socket.
 */
export class BrowserDirectRealtimePeer implements CodexRealtimeWebRtcPeer {
	readonly kind = "webrtc" as const;
	private readonly send: (message: unknown) => boolean;
	private readonly onSpeakerSuppressed: (suppressed: boolean) => void;
	private readonly onClosed: (() => void) | undefined;
	private readonly listeners = new Set<
		(event: CodexRealtimePeerEvent) => void
	>();
	private readonly exitListeners = new Set<(error: Error) => void>();
	private offer: PromiseWithResolvers<string> | undefined;
	private speakerSuppressed = false;
	private closed = false;

	constructor(options: {
		send(message: unknown): boolean;
		onSpeakerSuppressed(suppressed: boolean): void;
		onClosed?(): void;
	}) {
		this.onClosed = options.onClosed;
		this.send = options.send;
		this.onSpeakerSuppressed = options.onSpeakerSuppressed;
	}

	get isSpeakerSuppressed(): boolean {
		return this.speakerSuppressed;
	}

	onEvent(listener: (event: CodexRealtimePeerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onExit(listener: (error: Error) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	async start(_config: GippityControlConfig): Promise<string> {
		const offer = Promise.withResolvers<string>();
		this.offer = offer;
		if (!this.send({ type: "rtc.offer.request" }))
			throw new Error("The browser page is not connected");
		const timeout = setTimeout(
			() => offer.reject(new Error("The browser did not create a call offer")),
			OFFER_TIMEOUT_MS,
		);
		try {
			return await offer.promise;
		} finally {
			clearTimeout(timeout);
			if (this.offer === offer) this.offer = undefined;
		}
	}

	applyAnswer(sdp: string): void {
		this.require({ type: "rtc.answer", sdp });
	}

	sendData(message: unknown): void {
		this.require({ type: "rtc.send", message });
	}

	/** Call audio does not pass through the host in this mode. */
	sendAudio(_pcm: Buffer): void {}

	/** The page mutes its own microphone track. */
	setInputMuted(_muted: boolean): void {}

	setSpeakerSuppressed(suppressed: boolean): void {
		if (this.speakerSuppressed === suppressed) return;
		this.speakerSuppressed = suppressed;
		this.onSpeakerSuppressed(suppressed);
	}

	/** A message from the page that owns this call. */
	browserMessage(command: LanVoiceRtcCommand): void {
		if (this.closed) return;
		if (command.type === "rtc.offer") {
			this.offer?.resolve(command.sdp);
			return;
		}
		if (command.type === "rtc.error") {
			this.offer?.reject(new Error(command.message));
			this.emit({ type: "error", message: command.message });
			return;
		}
		if (command.type === "rtc.data")
			this.emit({ type: "data", message: command.message });
		else if (command.type === "rtc.state")
			this.emit({ type: "state", state: command.state });
		else this.emit({ type: "playback_activity" });
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.offer?.reject(new Error("The call was closed"));
		this.send({ type: "rtc.close" });
		this.onClosed?.();
	}

	private require(message: unknown): void {
		if (!this.send(message)) throw new Error("DataChannel is not opened");
	}

	private emit(event: CodexRealtimePeerEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
