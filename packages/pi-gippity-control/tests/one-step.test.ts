import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGippityPage } from "../src/command.ts";
import { normalizeGippityControlConfig } from "../src/config.ts";
import { runLanOpener } from "../src/voice/lan/opener.ts";

const URL_WITH_TOKEN = "https://localhost:43120/#token=secret-token";

function fakeLan() {
	let running = false;
	const calls: string[] = [];
	return {
		calls,
		status: () => ({ running, urls: running ? [URL_WITH_TOKEN] : [] }),
		setEnabled: async () => {
			calls.push(running ? "kept" : "started");
			running = true;
			return { running, urls: [URL_WITH_TOKEN] };
		},
	};
}

function fakeCtx() {
	const notes: Array<[string, string]> = [];
	return {
		notes,
		ctx: { ui: { notify: (m: string, l: string) => notes.push([l, m]) } },
	};
}

describe("bare /gippity", () => {
	test("starts once, opens the page each time, and never restarts a call", async () => {
		const lan = fakeLan();
		const { ctx, notes } = fakeCtx();
		const opened: Array<{ argv: readonly string[]; url: string }> = [];
		const config = normalizeGippityControlConfig({
			lan: {
				openCommand: ["ssh", "m5", "~/.local/bin/smarty-open-voice", "43120"],
			},
		});
		const open = async (argv: readonly string[], url: string) => {
			opened.push({ argv, url });
		};
		await openGippityPage(ctx as never, config, lan as never, open);
		await openGippityPage(ctx as never, config, lan as never, open);
		expect(lan.calls).toEqual(["started", "kept"]);
		expect(opened).toHaveLength(2);
		expect(opened[0]?.argv).toEqual([
			"ssh",
			"m5",
			"~/.local/bin/smarty-open-voice",
			"43120",
		]);
		expect(opened[0]?.url).toBe(URL_WITH_TOKEN);
		expect(notes.at(-1)?.[1]).toContain("voice button");
	});

	test("without an opener it shows the URL; a failed opener falls back to the URL", async () => {
		const lan = fakeLan();
		const { ctx, notes } = fakeCtx();
		await openGippityPage(
			ctx as never,
			normalizeGippityControlConfig({}),
			lan as never,
		);
		await openGippityPage(
			ctx as never,
			normalizeGippityControlConfig({}),
			lan as never,
		);
		expect(notes.at(-1)).toEqual([
			"info",
			`GipPity is running:\n${URL_WITH_TOKEN}`,
		]);
		await openGippityPage(
			ctx as never,
			normalizeGippityControlConfig({ lan: { openCommand: ["x"] } }),
			lan as never,
			async () => {
				throw new Error("ssh: connect failed");
			},
		);
		expect(notes.at(-1)?.[0]).toBe("warning");
		expect(notes.at(-1)?.[1]).toContain(URL_WITH_TOKEN);
	});

	test("rejects malformed openCommand config", () => {
		for (const openCommand of ["ssh m5 open", [], ["ssh", 5], [""]])
			expect(
				normalizeGippityControlConfig({ lan: { openCommand } }).lan.openCommand,
			).toBeUndefined();
	});
});

describe("page opener process", () => {
	test("gets the URL on stdin, never in argv, and runs without a shell", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gippity-opener-"));
		const script = join(dir, "opener.sh");
		writeFileSync(
			script,
			`#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\n`,
		);
		chmodSync(script, 0o755);
		await runLanOpener([script, "43120", "$(touch pwned)"], URL_WITH_TOKEN);
		expect(readFileSync(join(dir, "stdin"), "utf8")).toBe(
			`${URL_WITH_TOKEN}\n`,
		);
		const argv = readFileSync(join(dir, "argv"), "utf8");
		expect(argv).toBe("43120\n$(touch pwned)\n");
		expect(argv).not.toContain("secret-token");
	});

	test("reports a failing opener and times out a hung one", async () => {
		await expect(
			runLanOpener(["sh", "-c", "echo nope >&2; exit 3"], URL_WITH_TOKEN),
		).rejects.toThrow(/exit 3.*nope/);
		await expect(
			runLanOpener(["sleep", "5"], URL_WITH_TOKEN, 100),
		).rejects.toThrow(/timed out/);
	});
});
