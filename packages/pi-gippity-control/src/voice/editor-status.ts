import {
	CustomEditor,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	sliceByColumn,
	stripTerminalSequences,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<
	ReturnType<ExtensionContext["ui"]["getEditorComponent"]>
>;

export interface VoiceEditorLabels {
	top: string;
	bottom: string;
}

const MIN_BORDER_KEPT = 4;
const LIVE_WIDTH = 40;
const LIVE_SHARE = 0.45;
const TRANSCRIPT_CHARS = 400;
const LEVELS = "▁▂▃▄▅▆▇";
/** About 12 fps: smooth, and cheap for the TUI. */
const FRAME_MS = 80;
/** Call audio counts as active this long after the last report. */
const ACTIVITY_MS = 250;

/** The live status block width: fixed per terminal width, so it never jitters. */
export function liveStatusWidth(width: number): number {
	return Math.max(0, Math.min(LIVE_WIDTH, Math.floor(width * LIVE_SHARE)));
}

/**
 * Writes voice labels right-aligned over the editor's top and bottom border
 * lines. The line count never changes, each label is cut to fit, and at least
 * the first few border columns (and anything another extension drew at the
 * left) stay visible.
 */
export function decorateEditorBorders(
	lines: string[],
	width: number,
	labels: VoiceEditorLabels,
	style: (text: string) => string = (text) => text,
): string[] {
	if (lines.length < 2 || width <= MIN_BORDER_KEPT + 4) return lines;
	const out = [...lines];
	out[0] = overlayRight(out[0] ?? "", width, labels.top, style, false);
	const bottom = bottomBorderIndex(out);
	if (bottom > 0)
		out[bottom] = overlayRight(
			out[bottom] ?? "",
			width,
			labels.bottom,
			style,
			true,
		);
	return out;
}

function bottomBorderIndex(lines: string[]): number {
	for (let index = lines.length - 1; index > 0; index--)
		if (stripTerminalSequences(lines[index] ?? "").startsWith("─"))
			return index;
	return -1;
}

function overlayRight(
	line: string,
	width: number,
	label: string,
	style: (text: string) => string,
	keepTail: boolean,
): string {
	if (!label || visibleWidth(line) !== width) return line;
	const room = width - MIN_BORDER_KEPT - 3;
	const fitted = fit(label, room, keepTail);
	if (!fitted) return line;
	const text = ` ${fitted} `;
	const start = width - 1 - visibleWidth(text);
	return `${sliceByColumn(line, 0, start)}${style(text)}${sliceByColumn(line, width - 1, 1)}`;
}

/** Cuts plain text to a width, keeping the start (status) or the end (transcript). */
function fit(text: string, room: number, keepTail: boolean): string {
	if (room <= 1) return "";
	if (visibleWidth(text) <= room) return text;
	const characters = [...text];
	let kept = "";
	while (characters.length > 0) {
		const next = keepTail
			? `${characters.at(-1)}${kept}`
			: `${kept}${characters[0]}`;
		if (visibleWidth(next) + 1 > room) break;
		kept = next;
		if (keepTail) characters.pop();
		else characters.shift();
	}
	return keepTail ? `…${kept}` : `${kept}…`;
}

/**
 * Shows GipPity state inside Pi's input box instead of the footer, so a call
 * adds no rows. It wraps whichever editor factory is active and restores it
 * afterwards; typed text is kept across the swap by Pi.
 */
export class VoiceEditorStatus {
	private ctx: ExtensionContext | undefined;
	private previous: EditorFactory | undefined;
	private factory: EditorFactory | undefined;
	private tui: TUI | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private frame = 0;
	private lan = false;
	private call: { status: string; muted: boolean; quiet: boolean } | undefined;
	private readonly sides = {
		user: { text: "", final: false },
		assistant: { text: "", final: false },
	};
	private speaker: "user" | "assistant" | undefined;
	private lastAudio = 0;
	/** Test hook: frames rendered, and the clock. */
	now: () => number = Date.now;

	/** Returns false when Pi has no TUI editor; callers then use the footer. */
	setCall(
		ctx: ExtensionContext | undefined,
		call: { status: string; muted: boolean; quiet: boolean } | undefined,
	): boolean {
		if (call && !this.supported(ctx)) return false;
		this.call = call;
		if (!call) {
			for (const side of Object.values(this.sides)) side.text = "";
			this.speaker = undefined;
		}
		this.sync(ctx);
		return true;
	}

	setLan(ctx: ExtensionContext | undefined, running: boolean): boolean {
		if (running && !this.supported(ctx)) return false;
		this.lan = running;
		this.sync(ctx);
		return true;
	}

	/** Call audio is playing; the wave rises until activity stops. */
	audioActivity(): void {
		this.lastAudio = this.now();
	}

	/** Three bars: tall and moving while audio plays, a low ripple otherwise. */
	wave(): string {
		const loud = this.now() - this.lastAudio < ACTIVITY_MS;
		return [0, 1, 2]
			.map((bar) => {
				const phase = (this.frame + bar * 2) % 6;
				const height = loud ? 3 + Math.abs(3 - phase) : phase === 0 ? 1 : 0;
				return LEVELS[Math.min(LEVELS.length - 1, height)];
			})
			.join("");
	}

	transcript(role: "user" | "assistant", text: string, final: boolean): void {
		const side = this.sides[role];
		if (final) side.text = text;
		else side.text = side.final ? text : side.text + text;
		side.final = final;
		side.text = side.text.slice(-TRANSCRIPT_CHARS);
		if (!final || !this.speaker) this.speaker = role;
		this.tui?.requestRender();
	}

	/**
	 * One fixed-width block on the bottom border: activity wave, phase and
	 * mute, then the tail of whoever is speaking. Outside a call only the LAN
	 * indicator shows.
	 */
	labels(width: number): VoiceEditorLabels {
		if (!this.call) return { top: "", bottom: this.lan ? "GipPity LAN" : "" };
		const size = liveStatusWidth(width);
		const { status, muted, quiet } = this.call;
		const wave = this.wave();
		// While someone speaks, the tag names them and the words fill the block;
		// between turns the phase shows instead.
		const head = `${wave}${muted ? " muted" : quiet ? " quiet" : ""}`;
		const spoken = this.speaker
			? this.sides[this.speaker].text.trim().replace(/\s+/g, " ")
			: "";
		const tag = this.speaker === "user" ? "you: " : "gip: ";
		const room = size - visibleWidth(head) - 1 - tag.length;
		const words = spoken && room > 1 ? fit(spoken, room, true) : "";
		const label = fit(
			`${head} ${words ? `${tag}${words}` : status}`,
			size,
			false,
		);
		return {
			top: "",
			bottom: label + " ".repeat(Math.max(0, size - visibleWidth(label))),
		};
	}

	private supported(ctx: ExtensionContext | undefined): boolean {
		return (
			ctx?.mode === "tui" &&
			typeof ctx.ui.setEditorComponent === "function" &&
			typeof ctx.ui.getEditorComponent === "function"
		);
	}

	private sync(ctx: ExtensionContext | undefined): void {
		if (ctx) this.ctx = ctx;
		const wanted = this.lan || this.call !== undefined;
		if (wanted && !this.factory && this.ctx) this.install(this.ctx);
		if (!wanted && this.factory) this.uninstall();
		const animate = this.call !== undefined;
		if (animate && !this.timer) {
			this.timer = setInterval(() => {
				this.frame += 1;
				this.tui?.requestRender();
			}, FRAME_MS);
			this.timer.unref?.();
		} else if (!animate && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.tui?.requestRender();
	}

	private install(ctx: ExtensionContext): void {
		const previous = ctx.ui.getEditorComponent();
		const factory: EditorFactory = (tui, theme, keybindings) => {
			const editor = previous
				? previous(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings);
			const render = editor.render.bind(editor);
			editor.render = (width: number) =>
				decorateEditorBorders(
					render(width),
					width,
					this.labels(width),
					(text) => ctx.ui.theme.fg("accent", text),
				);
			this.tui = tui;
			return editor;
		};
		this.previous = previous;
		this.factory = factory;
		ctx.ui.setEditorComponent(factory);
	}

	private uninstall(): void {
		const ctx = this.ctx;
		if (ctx && ctx.ui.getEditorComponent() === this.factory)
			ctx.ui.setEditorComponent(this.previous);
		this.factory = undefined;
		this.previous = undefined;
		this.tui = undefined;
	}
}
