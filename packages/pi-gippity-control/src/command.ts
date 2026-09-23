import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { GippityControlConfig } from "./config.ts";
import {
	getGippityControlConfigPath,
	readGippityControlConfig,
	writeGippityControlConfig,
} from "./config-store.ts";
import { openGippitySettings } from "./settings.ts";
import type { CodexVoiceControls } from "./voice/controls.ts";
import type { CodexLanVoiceServerController } from "./voice/lan/controller.ts";
import { startLanRemoteCreateTurn } from "./voice/lan/create.ts";
import { runLanOpener } from "./voice/lan/opener.ts";

const ACTIONS = [
	"settings",
	"realtime",
	"mute",
	"dictation",
	"stop",
	"server",
	"create",
	"setup",
] as const;

export function registerGippityCommand(options: {
	pi: ExtensionAPI;
	state: { config: GippityControlConfig };
	voiceControls: CodexVoiceControls;
	lanVoice: CodexLanVoiceServerController;
}): void {
	const { pi, state, voiceControls, lanVoice } = options;
	const save = (
		ctx: ExtensionContext,
		config: GippityControlConfig,
	): boolean => {
		const result = writeGippityControlConfig(config);
		if (!result.ok) {
			ctx.ui.notify(
				`Could not save GipPity settings: ${result.error}`,
				"error",
			);
			return false;
		}
		state.config = config;
		return true;
	};

	pi.registerCommand("gippity", {
		description: "Control GipPity voice and LAN remote",
		getArgumentCompletions: (prefix) =>
			ACTIONS.filter((action) =>
				action.startsWith(prefix.trim().toLowerCase()),
			).map((value) => ({ label: value, value })),
		handler: async (args, ctx) => {
			state.config = readGippityControlConfig();
			const action = args.trim().toLowerCase();
			if (!action) {
				await openGippityPage(ctx, state.config, lanVoice);
				return;
			}
			if (action === "settings") {
				if (!ctx.hasUI) {
					ctx.ui.notify(formatStatus(state.config, lanVoice), "info");
					return;
				}
				await openGippitySettings({
					ctx,
					initialConfig: state.config,
					lanVoice,
					onChange: (config) => save(ctx, config),
				});
				return;
			}
			if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
				ctx.ui.notify(
					"Usage: /gippity [settings|realtime|mute|dictation|stop|server|create|setup]",
					"warning",
				);
				return;
			}
			if (action === "setup") {
				await ctx.waitForIdle();
				await voiceControls.setup(ctx);
				return;
			}
			if (action === "create") {
				try {
					await ctx.waitForIdle();
					const status = await lanVoice.setEnabled(true, ctx);
					const discovery = status.discovery;
					if (!discovery) throw new Error("Control server is not running");
					startLanRemoteCreateTurn(pi, {
						appDirectory: ctx.cwd,
						configPath: getGippityControlConfigPath(),
						discovery,
					});
				} catch (error) {
					ctx.ui.notify(
						`Could not create a GipPity web app: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("GipPity requires interactive TUI mode", "error");
				return;
			}
			if (action === "realtime" || action === "dictation") {
				await ctx.waitForIdle();
				await voiceControls.start(action, ctx);
				return;
			}
			if (action === "stop") {
				await voiceControls.stop(ctx);
				return;
			}
			if (action === "mute") {
				voiceControls.toggleInputMute(ctx);
				return;
			}
			const enabled = !lanVoice.status().running;
			try {
				await lanVoice.setEnabled(enabled, ctx);
				if (!enabled) ctx.ui.notify("GipPity control server stopped", "info");
			} catch (error) {
				ctx.ui.notify(
					`Could not ${enabled ? "start" : "stop"} GipPity: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}

/**
 * One step to talk: start the control server if it is not running (a running
 * server and its call are kept), then open the page with the configured
 * opener. The page's voice button starts or joins the call. The URL is always
 * shown as a fallback.
 */
export async function openGippityPage(
	ctx: ExtensionContext,
	config: GippityControlConfig,
	lanVoice: Pick<CodexLanVoiceServerController, "status" | "setEnabled">,
	open: typeof runLanOpener = runLanOpener,
): Promise<void> {
	const wasRunning = lanVoice.status().running;
	let status: Awaited<ReturnType<typeof lanVoice.setEnabled>>;
	try {
		status = await lanVoice.setEnabled(true, ctx);
	} catch (error) {
		ctx.ui.notify(
			`Could not start GipPity: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}
	const url = status.urls[0];
	if (!url) return;
	const opener = config.lan.openCommand;
	if (opener) {
		try {
			await open(opener, url);
			ctx.ui.notify(
				"GipPity page opened. Press the voice button to talk.",
				"info",
			);
			return;
		} catch (error) {
			ctx.ui.notify(
				`Could not open the GipPity page (${error instanceof Error ? error.message : String(error)}). Open it yourself:\n${url}`,
				"warning",
			);
			return;
		}
	}
	// The first start already printed the URL.
	if (wasRunning) ctx.ui.notify(`GipPity is running:\n${url}`, "info");
}

function formatStatus(
	config: GippityControlConfig,
	lanVoice: CodexLanVoiceServerController,
): string {
	const server = lanVoice.status();
	return `GipPity: voice ${config.voice.v3Voice}, dictation ${config.voice.dictationShortcutMode}, server ${server.running ? server.urls.join(", ") : "off"}`;
}
