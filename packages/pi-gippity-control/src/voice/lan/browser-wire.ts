import type { RawData } from "ws";
import { decodeLanVoiceAudioCommand } from "./protocol.ts";

export const MAX_CONTROL_BYTES = 64 * 1024;
/** Data-channel events relayed from the page (session.updated echoes instructions). */
export const MAX_RTC_DATA_BYTES = 512 * 1024;
/** The audio socket's frame limit. */
export const MAX_AUDIO_SOCKET_BYTES = MAX_RTC_DATA_BYTES + 1024;
const MAX_PCM_BYTES = 24_000 * 2;

export type LanVoiceBrowserInput =
	| { type: "audio"; pcm: Buffer }
	| { type: "control"; command: ReturnType<typeof decodeLanVoiceAudioCommand> };

export function decodeLanVoiceBrowserInput(
	data: RawData,
	isBinary: boolean,
): LanVoiceBrowserInput {
	const buffer = rawBuffer(data);
	if (isBinary) {
		if (
			buffer.byteLength === 0 ||
			buffer.byteLength > MAX_PCM_BYTES ||
			buffer.byteLength % 2 !== 0
		)
			throw new Error("Invalid LAN voice PCM frame");
		return { type: "audio", pcm: buffer };
	}
	if (buffer.byteLength > MAX_AUDIO_SOCKET_BYTES)
		throw new Error("LAN voice control message is too large");
	const command = decodeLanVoiceAudioCommand(
		JSON.parse(buffer.toString("utf8")),
	);
	if (
		buffer.byteLength >
		(command.type === "rtc.data" ? MAX_RTC_DATA_BYTES + 256 : MAX_CONTROL_BYTES)
	)
		throw new Error("LAN voice control message is too large");
	return { type: "control", command };
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function rawBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}
