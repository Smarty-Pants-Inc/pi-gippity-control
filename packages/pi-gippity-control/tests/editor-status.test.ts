import { describe, expect, test } from "bun:test";
import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import {
	decorateEditorBorders,
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
				bottom: `you: ${"can you check the build on dev two ".repeat(4)} gip: sure`,
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
		status.transcript("assistant", "It is green.", true);
		const editor = (
			wrapped as (...args: unknown[]) => { render(w: number): string[] }
		)(TUI, THEME, {});
		const plain = editor
			.render(80)
			.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
		expect(plain[0]).toMatch(/[▁-▇]{3} listening ─$/);
		expect(plain.at(-1)).toContain("you: check the build  gip: It is green. ─");
		expect(status.setCall(ctx as never, undefined)).toBe(true);
		expect(current()).toBe(previous);
		status.setCall(ctx as never, {
			status: "listening",
			muted: false,
			quiet: false,
		});
		expect(status.labels().bottom).toBe("");
	});

	test("the LAN indicator keeps the border until both LAN and call end", () => {
		const { ctx, current } = fakeContext();
		const status = new VoiceEditorStatus();
		status.setLan(ctx as never, true);
		const wrapped = current();
		expect(wrapped).toBeDefined();
		status.setCall(ctx as never, {
			status: "speaking",
			muted: true,
			quiet: false,
		});
		expect(current()).toBe(wrapped);
		expect(status.labels().top).toMatch(
			/^GipPity LAN · [▁-▇]{3} speaking · muted$/,
		);
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
