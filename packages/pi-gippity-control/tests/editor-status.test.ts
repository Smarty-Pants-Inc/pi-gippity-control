import { describe, expect, test } from "bun:test";
import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import {
	decorateEditorBorders,
	liveStatusWidth,
	VoiceEditorStatus,
} from "../src/voice/editor-status.ts";

const identity = (text: string) => text;
const THEME = {
	borderColor: (text: string) => `\x1b[36m${text}\x1b[39m`,
	selectList: {
		selectedPrefix: identity,
		selectedText: identity,
		description: identity,
		scrollInfo: identity,
		noMatch: identity,
	},
};
const TUI = { requestRender() {}, terminal: { rows: 40, columns: 80 } };

function realEditor(text = "") {
	const editor = new Editor(TUI as never, THEME);
	editor.setText(text);
	return editor;
}

describe("voice status inside the editor border", () => {
	test("adds no rows and keeps every line exactly as wide", () => {
		for (const width of [80, 120, 40]) {
			const lines = realEditor("typing a question").render(width);
			const decorated = decorateEditorBorders(lines, width, {
				top: "GipPity LAN · ▂▅▇ listening · muted",
				bottom: `you: ${"can you check the build on dev two ".repeat(4)} agent: sure`,
			});
			expect(decorated).toHaveLength(lines.length);
			for (const line of decorated) expect(visibleWidth(line)).toBe(width);
			// The typed text and the border start are untouched.
			expect(decorated.slice(1, -1)).toEqual(lines.slice(1, -1));
			expect(decorated[0]?.startsWith(lines[0]?.slice(0, 8) ?? "x")).toBe(true);
		}
	});

	test("truncates gracefully at 80 columns: status keeps its start, transcript its end", () => {
		const lines = realEditor().render(80);
		const [top, , bottom] = decorateEditorBorders(lines, 80, {
			top: `listening ${"x".repeat(200)}`,
			bottom: `you: ${"a".repeat(200)} newest words`,
		}).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
		expect(top).toContain(" listening x");
		expect(top).toContain("… ");
		expect(bottom).toContain("…");
		expect(bottom).toContain("newest words ─");
		expect(top?.startsWith("────")).toBe(true);
	});

	test("finds the bottom border above autocomplete rows", () => {
		const lines = [
			"────────────────────",
			"text",
			"────────────────────",
			"  → /gippity",
			"    /live",
		];
		const decorated = decorateEditorBorders(lines, 20, {
			top: "",
			bottom: "hi",
		});
		expect(decorated[2]).toBe("─────────────── hi ─");
		expect(decorated.slice(3)).toEqual(lines.slice(3));
	});

	test("wraps the active editor during a call and restores it after", () => {
		const { ctx, current } = fakeContext();
		const previous = (() => realEditor()) as never;
		ctx.ui.setEditorComponent(previous);
		const status = new VoiceEditorStatus();
		expect(
			status.setCall(ctx as never, {
				status: "listening",
				muted: false,
				quiet: false,
			}),
		).toBe(true);
		const wrapped = current();
		expect(wrapped).not.toBe(previous);
		status.transcript("user", "check the ", false);
		status.transcript("user", "build", false);
		const editor = (
			wrapped as (...args: unknown[]) => { render(w: number): string[] }
		)(TUI, THEME, {});
		const lines = editor.render(80);
		const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
		expect(lines).toHaveLength(realEditor().render(80).length);
		// Only the bottom border carries the block; the top border is untouched.
		expect(plain[0]).toMatch(/^─+$/);
		expect(plain.at(-1)).toMatch(/[▁-▇]{3} you: check the build +─$/);
		expect(status.setCall(ctx as never, undefined)).toBe(true);
		expect(current()).toBe(previous);
	});

	test("one speaker at a time, in a fixed-width block that shows the tail", () => {
		const { ctx } = fakeContext();
		const status = new VoiceEditorStatus();
		status.setCall(ctx as never, {
			status: "speaking",
			muted: true,
			quiet: false,
		});
		const width = (text: string) => visibleWidth(text);
		const blocks: string[] = [];
		expect(status.labels(80).bottom).toMatch(/^[▁-▇]{3} muted speaking +$/);
		status.transcript("user", "what is the build state", true);
		blocks.push(status.labels(80).bottom);
		expect(blocks[0]).toContain("you: …t is the build state");
		expect(blocks[0]).toMatch(/^[▁-▇]{3} muted you: /);
		status.transcript("assistant", "It is green", false);
		blocks.push(status.labels(80).bottom);
		expect(blocks[1]).toContain("agent: It is green");
		expect(blocks[1]).not.toContain("you:");
		status.transcript(
			"assistant",
			`, and ${"all checks passed ".repeat(5)}on main`,
			false,
		);
		blocks.push(status.labels(80).bottom);
		expect(blocks[2]).toMatch(/ agent: ….*on main *$/);
		// Fixed width: no jitter as text grows; 40 columns at 80, 45% when narrow.
		for (const block of blocks) expect(width(block)).toBe(liveStatusWidth(80));
		expect(liveStatusWidth(80)).toBe(36);
		expect(liveStatusWidth(200)).toBe(40);
		expect(width(status.labels(60).bottom)).toBe(27);
	});

	test("the LAN indicator keeps the border until both LAN and call end", () => {
		const { ctx, current } = fakeContext();
		const status = new VoiceEditorStatus();
		status.setLan(ctx as never, true);
		const wrapped = current();
		expect(wrapped).toBeDefined();
		expect(status.labels(80).bottom).toBe("GipPity LAN");
		status.setCall(ctx as never, {
			status: "speaking",
			muted: true,
			quiet: false,
		});
		expect(current()).toBe(wrapped);
		status.setCall(ctx as never, undefined);
		expect(current()).toBe(wrapped);
		status.setLan(ctx as never, false);
		expect(current()).toBeUndefined();
	});

	test("falls back to the footer without a TUI editor", () => {
		const { ctx } = fakeContext("rpc");
		const status = new VoiceEditorStatus();
		expect(
			status.setCall(ctx as never, {
				status: "listening",
				muted: false,
				quiet: false,
			}),
		).toBe(false);
		expect(status.setLan(ctx as never, true)).toBe(false);
	});
});

function fakeContext(mode = "tui") {
	let factory: unknown;
	const ctx = {
		mode,
		ui: {
			theme: { fg: (_name: string, text: string) => text },
			getEditorComponent: () => factory,
			setEditorComponent: (next: unknown) => {
				factory = next;
			},
		},
	};
	return { ctx, current: () => factory };
}

describe("live transcript text", () => {
	test("keeps the spaces between streamed deltas", () => {
		const status = new VoiceEditorStatus();
		const { ctx } = fakeContextForTranscript();
		status.setCall(ctx as never, {
			status: "speaking",
			muted: false,
			quiet: false,
		});
		for (const delta of ["Hey", " there!", " What's", " up?"])
			status.transcript("assistant", delta, false);
		expect(status.labels(200).bottom.trim()).toMatch(
			/agent: Hey there! What's up\?$/,
		);
	});
});

function fakeContextForTranscript() {
	let factory: unknown;
	return {
		ctx: {
			mode: "tui",
			ui: {
				theme: { fg: (_name: string, text: string) => text },
				getEditorComponent: () => factory,
				setEditorComponent: (next: unknown) => {
					factory = next;
				},
			},
		},
	};
}

describe("live status animation", () => {
	test("renders at about 12 fps during a call; bars follow real levels", async () => {
		const { ctx } = fakeContextForTranscript();
		const status = new VoiceEditorStatus();
		status.setCall(ctx as never, {
			status: "listening",
			muted: false,
			quiet: false,
		});
		const factory = (
			ctx.ui.getEditorComponent as () => (...a: unknown[]) => unknown
		)();
		let renders = 0;
		factory(
			{
				requestRender: () => (renders += 1),
				terminal: { rows: 40, columns: 80 },
			},
			THEME,
			{},
		);
		renders = 0;
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(renders).toBeGreaterThanOrEqual(5);
		expect(status.wave()).toBe("▁▁▁");
		const height = (wave: string) =>
			[...wave].reduce((sum, bar) => sum + "▁▂▃▄▅▆▇".indexOf(bar), 0);
		for (let i = 0; i < 3; i++) status.level(0.003, 0); // quiet speech, about -50 dB
		const quiet = status.wave();
		for (let i = 0; i < 3; i++) status.level(0.3, 0); // loud speech, about -10 dB
		const loud = status.wave();
		for (let i = 0; i < 3; i++) status.level(0, 0.3); // the voice speaking
		expect(status.wave()).toBe(loud);
		expect(height(loud)).toBeGreaterThan(height(quiet) + 9);
		expect(loud).toBe("▆▆▆");
		// Flat again when no level arrives.
		const now = Date.now();
		status.now = () => now + 1000;
		expect(status.wave()).toBe("▁▁▁");
		status.now = Date.now;
		status.setCall(ctx as never, undefined);
		renders = 0;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(renders).toBe(0);
	});
});

describe("speaker label follows who is audible", () => {
	test("switches to 'you: …' as soon as the mic is loud, before a transcript", () => {
		const { ctx } = fakeContextForTranscript();
		const status = new VoiceEditorStatus();
		status.setCall(ctx as never, {
			status: "listening",
			muted: false,
			quiet: false,
		});
		status.transcript("assistant", "What are we getting into today?", true);
		expect(status.labels(80).bottom).toContain("agent: ");
		status.level(0.3, 0); // one loud sample is not enough (no flicker)
		expect(status.labels(80).bottom).toContain("agent: ");
		status.level(0.3, 0);
		expect(status.labels(80).bottom).toMatch(/ you: … *$/);
		status.transcript("user", "check the", false);
		expect(status.labels(80).bottom).toMatch(/ you: check the *$/);
		status.level(0.002, 0); // room noise does not switch it back
		status.level(0.002, 0);
		expect(status.labels(80).bottom).toContain("you: check the");
		status.level(0, 0.3);
		status.level(0, 0.3);
		expect(status.labels(80).bottom).toMatch(/ agent: … *$/);
	});
});
