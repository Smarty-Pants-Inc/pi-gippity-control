import type { GippityControlConfig } from "../../config.ts";

export const MAX_REALTIME_SDP_BYTES = 256 * 1024;

export type CodexRealtimePeerEvent =
	| { type: "state"; state: string }
	| { type: "data"; message: unknown }
	| { type: "playback_activity" }
	/** Live audio levels, 0..1 amplitude: microphone input and call output. */
	| { type: "level"; input: number; output: number }
	| { type: "error"; message: string };

interface CodexRealtimePeerBase {
	onEvent(listener: (event: CodexRealtimePeerEvent) => void): () => void;
	onExit(listener: (error: Error) => void): () => void;
	sendData(message: unknown): void;
	setInputMuted(muted: boolean): void;
	setSpeakerSuppressed(suppressed: boolean): void;
	close(): Promise<void>;
}

export interface CodexRealtimeWebRtcPeer extends CodexRealtimePeerBase {
	readonly kind: "webrtc";
	start(config: GippityControlConfig): Promise<string>;
	applyAnswer(sdp: string): void;
}

export type CodexRealtimePeer = CodexRealtimeWebRtcPeer;
