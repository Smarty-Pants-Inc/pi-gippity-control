export type LanVoiceAudioCommand =
	| { type: "start"; mode: "conversation" | "dictation" }
	| { type: "mute"; muted: boolean }
	| {
			type: "finish";
			draft: string;
			revision: number;
			selection: { start: number; end: number };
	  }
	| { type: "release" }
	| { type: "cancel" }
	| LanVoiceRtcCommand;

/** Messages from a page that holds the call's RTCPeerConnection. */
export type LanVoiceRtcCommand =
	| { type: "rtc.offer"; sdp: string }
	| { type: "rtc.data"; message: Record<string, unknown> }
	| { type: "rtc.state"; state: string }
	| { type: "rtc.playback"; level: number }
	| { type: "rtc.error"; message: string };

const RTC_STATES = new Set([
	"ready",
	"connecting",
	"connected",
	"disconnected",
	"failed",
	"closed",
]);
const MAX_RTC_SDP_BYTES = 256 * 1024;

export function decodeLanVoiceAudioCommand(
	value: unknown,
): LanVoiceAudioCommand {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!("type" in value)
	)
		throw invalidCommand();
	if (value.type === "start") {
		if (
			!("mode" in value) ||
			(value.mode !== "conversation" && value.mode !== "dictation")
		)
			throw invalidCommand();
		return { type: "start", mode: value.mode };
	}
	if (value.type === "finish") {
		if (!("draft" in value) || typeof value.draft !== "string")
			throw invalidCommand();
		if (
			!("revision" in value) ||
			typeof value.revision !== "number" ||
			!Number.isSafeInteger(value.revision)
		)
			throw invalidCommand();
		if (
			!("selectionStart" in value) ||
			!validSelectionIndex(value.selectionStart, value.draft.length)
		)
			throw invalidCommand();
		if (
			!("selectionEnd" in value) ||
			!validSelectionIndex(value.selectionEnd, value.draft.length)
		)
			throw invalidCommand();
		return {
			type: "finish",
			draft: value.draft,
			revision: value.revision,
			selection: { start: value.selectionStart, end: value.selectionEnd },
		};
	}
	if (value.type === "mute") {
		if (!("muted" in value) || typeof value.muted !== "boolean")
			throw invalidCommand();
		return { type: "mute", muted: value.muted };
	}
	if (value.type === "release" || value.type === "cancel")
		return { type: value.type };
	return decodeRtcCommand(value);
}

function decodeRtcCommand(
	value: object & { type: unknown },
): LanVoiceRtcCommand {
	const record = value as Record<string, unknown>;
	if (value.type === "rtc.offer") {
		const sdp = record["sdp"];
		if (
			typeof sdp !== "string" ||
			!sdp.startsWith("v=0") ||
			Buffer.byteLength(sdp) > MAX_RTC_SDP_BYTES
		)
			throw invalidCommand();
		return { type: "rtc.offer", sdp };
	}
	if (value.type === "rtc.data") {
		const message = record["message"];
		if (!message || typeof message !== "object" || Array.isArray(message))
			throw invalidCommand();
		return { type: "rtc.data", message: message as Record<string, unknown> };
	}
	if (value.type === "rtc.state") {
		const state = record["state"];
		if (typeof state !== "string" || !RTC_STATES.has(state))
			throw invalidCommand();
		return { type: "rtc.state", state };
	}
	if (value.type === "rtc.playback") {
		const level = record["level"];
		return {
			type: "rtc.playback",
			level:
				typeof level === "number" && Number.isFinite(level)
					? Math.min(1, Math.max(0, level))
					: 0,
		};
	}
	if (value.type === "rtc.error") {
		const message = record["message"];
		if (typeof message !== "string") throw invalidCommand();
		return {
			type: "rtc.error",
			message: message.slice(0, 500) || "Browser call failed",
		};
	}
	throw invalidCommand();
}

function validSelectionIndex(
	value: unknown,
	draftLength: number,
): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= draftLength
	);
}

function invalidCommand(): Error {
	return new Error("Invalid LAN voice control message");
}
