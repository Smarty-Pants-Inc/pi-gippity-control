import { describe, expect, test } from "bun:test";
import { normalizeGippityControlConfig } from "../src/config.ts";
import { LAN_AUDIO_DEVICES_SCRIPT } from "../src/voice/lan/audio-devices-script.ts";
import { LAN_VOICE_BROWSER_SCRIPT } from "../src/voice/lan/browser-script.ts";
import { LAN_REMOTE_CLIENT_SCRIPT } from "../src/voice/lan/client-sdk-script.ts";

interface Devices {
	snapshot(): { input: string; output: string; warnings: string[] };
	setDefaults(value: { inputDevice?: string; outputDevice?: string }): void;
	refresh(): Promise<void>;
	select(kind: "input" | "output", label: string): Promise<void>;
	inputConstraints(base: object): Record<string, unknown>;
	needsReopen(stream: unknown): boolean;
	attach(target: unknown): Promise<void>;
}

const MAC_DEVICES = [
	{
		kind: "audioinput",
		deviceId: "default",
		label: "Default - MacBook Pro Microphone",
	},
	{
		kind: "audioinput",
		deviceId: "mic-mbp",
		label: "MacBook Pro Microphone (Built-in)",
	},
	{ kind: "audioinput", deviceId: "mic-yl", label: "Yealink BT51 (Bluetooth)" },
	{
		kind: "audiooutput",
		deviceId: "default",
		label: "Default - MacBook Pro Speakers",
	},
	{
		kind: "audiooutput",
		deviceId: "out-mbp",
		label: "MacBook Pro Speakers (Built-in)",
	},
	{
		kind: "audiooutput",
		deviceId: "out-yl",
		label: "Yealink BT51 (Bluetooth)",
	},
];

function createDevices(
	devices: object[] = MAC_DEVICES,
	storage = new Map<string, string>(),
) {
	const factory = new Function(
		`${LAN_AUDIO_DEVICES_SCRIPT}; return createAudioDevices;`,
	)() as (options: object) => Devices;
	const changes: unknown[] = [];
	const instance = factory({
		mediaDevices: { enumerateDevices: async () => devices },
		storage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
		},
		onChange: (value: unknown) => changes.push(value),
	});
	return { devices: instance, storage, changes };
}

function fakeContext() {
	const sinks: string[] = [];
	return {
		sinks,
		setSinkId: async (id: string) => {
			sinks.push(id);
		},
	};
}

describe("browser audio devices", () => {
	test("config default picks the Yealink by label for mic and speaker", async () => {
		const { devices } = createDevices();
		devices.setDefaults({
			inputDevice: "Yealink BT51",
			outputDevice: "Yealink BT51",
		});
		await devices.refresh();
		expect(devices.inputConstraints({ channelCount: 1 })).toEqual({
			channelCount: 1,
			deviceId: { exact: "mic-yl" },
		});
		const context = fakeContext();
		await devices.attach(context);
		expect(context.sinks).toEqual(["out-yl"]);
		expect(devices.snapshot().warnings).toEqual([]);
	});

	test("matches Paul's Yealink through Chrome label suffixes, case-insensitively", async () => {
		const others = [
			{
				kind: "audioinput",
				deviceId: "default",
				label: "Default - Yealink BT51 (6993:b0b7)",
			},
			{
				kind: "audioinput",
				deviceId: "mic-mbp",
				label: "MacBook Pro Microphone",
			},
			{ kind: "audioinput", deviceId: "mic-camo", label: "Camo Microphone" },
			{
				kind: "audioinput",
				deviceId: "mic-phone",
				label: "Paul's iPhone Microphone",
			},
			{
				kind: "audiooutput",
				deviceId: "out-mbp",
				label: "MacBook Pro Speakers",
			},
		];
		for (const [input, output] of [
			["Yealink BT51 (Bluetooth)", "Yealink BT51 (Bluetooth)"],
			["Yealink BT51 (6993:b0b7)", "Yealink BT51 (6993:b0b7)"],
		]) {
			const { devices } = createDevices([
				...others,
				{ kind: "audioinput", deviceId: "mic-yl", label: input },
				{ kind: "audiooutput", deviceId: "out-yl", label: output },
			]);
			devices.setDefaults({
				inputDevice: "yealink bt51",
				outputDevice: "YEALINK BT51",
			});
			await devices.refresh();
			expect(devices.inputConstraints({})).toEqual({
				deviceId: { exact: "mic-yl" },
			});
			const context = fakeContext();
			await devices.attach(context);
			expect(context.sinks).toEqual(["out-yl"]);
		}
	});

	test("never picks the MacBook devices for 'Yealink BT51'", async () => {
		const { devices } = createDevices([
			{
				kind: "audioinput",
				deviceId: "default",
				label: "Default - MacBook Pro Microphone",
			},
			{
				kind: "audioinput",
				deviceId: "mic-mbp",
				label: "MacBook Pro Microphone",
			},
			{ kind: "audioinput", deviceId: "mic-camo", label: "Camo Microphone" },
			{
				kind: "audiooutput",
				deviceId: "out-mbp",
				label: "MacBook Pro Speakers",
			},
		]);
		devices.setDefaults({
			inputDevice: "Yealink BT51",
			outputDevice: "Yealink BT51",
		});
		await devices.refresh();
		// No deviceId constraint: the system default is used, with a warning.
		expect(devices.inputConstraints({})).toEqual({});
		const context = fakeContext();
		await devices.attach(context);
		expect(context.sinks).toEqual([""]);
		expect(devices.snapshot().warnings).toHaveLength(2);
	});

	test("a missing device warns and falls back to the system default", async () => {
		const { devices } = createDevices(
			MAC_DEVICES.filter((device) => !device.label.startsWith("Yealink")),
		);
		devices.setDefaults({
			inputDevice: "Yealink BT51",
			outputDevice: "Yealink BT51",
		});
		await devices.refresh();
		expect(devices.inputConstraints({ channelCount: 1 })).toEqual({
			channelCount: 1,
		});
		const context = fakeContext();
		await devices.attach(context);
		expect(context.sinks).toEqual([""]);
		const warnings = devices.snapshot().warnings.join(" ");
		expect(warnings).toContain("Yealink BT51 (microphone) is not available");
		expect(warnings).toContain("Yealink BT51 (speaker) is not available");
	});

	test("does not warn before microphone permission reveals labels", async () => {
		const { devices } = createDevices(
			MAC_DEVICES.map((device) => ({ ...device, label: "" })),
		);
		devices.setDefaults({ inputDevice: "Yealink BT51" });
		await devices.refresh();
		expect(devices.snapshot().warnings).toEqual([]);
	});

	test("a page choice persists and wins over the config default", async () => {
		const first = createDevices();
		first.devices.setDefaults({ outputDevice: "Yealink BT51" });
		await first.devices.refresh();
		const context = fakeContext();
		await first.devices.attach(context);
		await first.devices.select("output", "MacBook Pro Speakers (Built-in)");
		expect(context.sinks).toEqual(["out-yl", "out-mbp"]);
		expect(first.storage.get("gippity-audio-output")).toBe(
			"MacBook Pro Speakers (Built-in)",
		);
		const reload = createDevices(MAC_DEVICES, first.storage);
		reload.devices.setDefaults({ outputDevice: "Yealink BT51" });
		await reload.devices.refresh();
		expect(reload.devices.snapshot().output).toBe(
			"MacBook Pro Speakers (Built-in)",
		);
	});

	test("reopens the microphone when the open track is another device", async () => {
		const { devices } = createDevices();
		devices.setDefaults({ inputDevice: "Yealink BT51" });
		await devices.refresh();
		const track = (deviceId: string) => ({
			getAudioTracks: () => [{ getSettings: () => ({ deviceId }) }],
		});
		expect(devices.needsReopen(track("mic-mbp"))).toBe(true);
		expect(devices.needsReopen(track("mic-yl"))).toBe(false);
	});

	test("a device that appears later is applied to the open call", async () => {
		const list = MAC_DEVICES.filter(
			(device) => !device.label.startsWith("Yealink"),
		);
		const { devices } = createDevices(list);
		devices.setDefaults({ outputDevice: "Yealink BT51" });
		await devices.refresh();
		const context = fakeContext();
		await devices.attach(context);
		list.push(
			...MAC_DEVICES.filter((device) => device.label.startsWith("Yealink")),
		);
		await devices.refresh(); // devicechange
		expect(context.sinks).toEqual(["", "out-yl"]);
		expect(devices.snapshot().warnings).toEqual([]);
	});

	test("hosted scripts parse and config carries browser defaults", () => {
		expect(() => new Function(LAN_REMOTE_CLIENT_SCRIPT)).not.toThrow();
		expect(() => new Function(LAN_VOICE_BROWSER_SCRIPT)).not.toThrow();
		const config = normalizeGippityControlConfig({
			lan: {
				audio: { inputDevice: "Yealink BT51", outputDevice: "Yealink BT51" },
			},
		});
		expect(config.lan.audio).toEqual({
			inputDevice: "Yealink BT51",
			outputDevice: "Yealink BT51",
		});
	});
});
