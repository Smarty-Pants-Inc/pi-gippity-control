import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GIPPITY_CONTROL_CONFIG } from "../src/config.ts";
import { registerGippityControl } from "../src/register.ts";
import { registerCodexVoiceShortcuts } from "../src/voice/shortcuts.ts";

// Typing in the Pi editor during a call, and loading beside pi-better-openai.

describe("Pi editor stays free during a call", () => {
	test("plain editing keys pass through; shortcuts are chords", () => {
		const shortcuts: string[] = [];
		const sessionStart: Array<(event: unknown, ctx: unknown) => void> = [];
		const pi = {
			registerShortcut: (key: string) => shortcuts.push(key),
			on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
				if (event === "session_start") sessionStart.push(handler);
			},
		};
		let listener: ((data: string) => unknown) | undefined;
		registerCodexVoiceShortcuts(
			pi as never,
			DEFAULT_GIPPITY_CONTROL_CONFIG,
			() => DEFAULT_GIPPITY_CONTROL_CONFIG,
			{} as never,
		);
		for (const handler of sessionStart)
			handler(
				{},
				{
					ui: {
						onTerminalInput: (next: (data: string) => unknown) => {
							listener = next;
							return () => {};
						},
						notify() {},
					},
				},
			);
		expect(shortcuts.sort()).toEqual([
			"ctrl+alt+d",
			"ctrl+alt+g",
			"ctrl+alt+m",
			"ctrl+alt+space",
		]);
		for (const key of [" ", "\x1b", "\r", "\n", "a", "\x7f", "\t"])
			expect(listener?.(key)).toBeUndefined();
	});
});

describe("loading beside pi-better-openai", () => {
	const previous = process.env["PI_CODING_AGENT_DIR"];
	const agentDir = mkdtempSync(join(tmpdir(), "gippity-coexist-"));
	beforeAll(() => {
		process.env["PI_CODING_AGENT_DIR"] = agentDir;
	});
	afterAll(() => {
		if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previous;
		rmSync(agentDir, { recursive: true, force: true });
	});

	test("registers only /gippity, chord shortcuts and no tools", () => {
		const calls = new Map<string, unknown[][]>();
		const record =
			(name: string) =>
			(...args: unknown[]) => {
				calls.set(name, [...(calls.get(name) ?? []), args]);
				return () => {};
			};
		const pi = new Proxy(
			{ events: { on: record("events.on"), emit: record("events.emit") } },
			{
				get: (target, name: string) =>
					name in target ? target[name as keyof typeof target] : record(name),
			},
		);
		registerGippityControl(pi as never);
		expect((calls.get("registerCommand") ?? []).map(([name]) => name)).toEqual([
			"gippity",
		]);
		expect(calls.get("registerTool")).toBeUndefined();
		const keys = (calls.get("registerShortcut") ?? []).map(([key]) => key);
		expect(keys.length).toBeGreaterThan(0);
		// pi-better-openai uses /live, /openai-*, /fast, /pets and ctrl+shift+l.
		for (const key of keys) expect(String(key)).toMatch(/^ctrl\+alt\+/);
	});
});
