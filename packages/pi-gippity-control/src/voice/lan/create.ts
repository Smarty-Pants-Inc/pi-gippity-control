import { fileURLToPath } from "node:url";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const CREATE_NOTICE_TYPE = "gippity-remote-create-notice";
const CREATE_PROMPT_TYPE = "gippity-remote-create-prompt";
const CREATE_PROMPT_HEADER =
	"GipPity custom remote web app creation was requested.";
const CREATE_PROMPT_GUIDANCE = [
	"First study the discovery document above and the browser client source file, and familiarize yourself with the browser client, events, audio, draft, and Pi/context JSON-RPC contracts. The document is authoritative. It carries no access credential: do not look for one, and do not fetch anything from the live GipPity server.",
	"This first turn is research and product discovery only. Inspect the existing project and the documentation above, but do not create or edit files, install dependencies, change config, or begin implementation.",
	"After investigating, quiz the user about what they want the app to do and feel like: its purpose, desired controls and status, visual direction, target devices/layout, genuine non-negotiables, and whether it should be global or only for the current project. Do not burden them with implementation choices you can infer yourself. Then stop and wait for their answer.",
	"Only after the user answers should you implement a polished static web app. Use the hosted GippityRemote browser client so it retains GipPity's synchronization, audio, reconnection, and handoff behavior. Do not start or require another web server; GipPity hosts the static output.",
	"When implementation is complete, set lan.customWebApp to true and lan.customWebAppPath to the directory containing the finished index.html. Use an absolute path for one global app in every directory, or a path relative to the Pi session cwd for a project-specific app. Preserve every unrelated config value. The running GipPity server discovers a valid new path automatically; ask the user to refresh or open its URL.",
	"Important: the live server is wired to this exact Pi session. Do not make any request to it—no RPC, GippityRemote.call, send/draft controls, audio controls, or other live operations—while implementing; the calls would target your own session and may interrupt or replace it. Rely on the user to open the app, test operations, and report behavior.",
	"Build and statically validate the app. When it is ready, tell the user what changed, ask them to refresh or open the GipPity URL, and have them perform the live checks you need.",
] as const;

type CreateNoticeDetails = Record<string, never>;

interface CreatePromptDetails {
	appDirectory: string;
}

const CLIENT_SOURCE_PATH = fileURLToPath(
	new URL("./client-sdk-script.ts", import.meta.url),
);

export function registerLanRemoteCreateRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<CreateNoticeDetails>(
		CREATE_NOTICE_TYPE,
		(_entry, _options, theme) =>
			remoteBox(
				theme,
				"GipPity Remote",
				"No custom web app is connected.\nRun /gippity create to have Pi build one.",
			),
	);
	pi.registerEntryRenderer<CreatePromptDetails>(
		CREATE_PROMPT_TYPE,
		(entry, _options, theme) =>
			remoteBox(
				theme,
				"GipPity Web App",
				`Planning a custom remote in ${entry.data?.appDirectory ?? "the current project"}.\nPi will inspect the GipPity contract, then ask what you want.`,
			),
	);
	pi.registerMarkdownTransformer((markdown, { messageType }) =>
		messageType === "user" && isLanRemoteCreatePrompt(markdown) ? "" : markdown,
	);
}

export function appendLanRemoteCreateNotice(pi: ExtensionAPI): void {
	pi.appendEntry<CreateNoticeDetails>(CREATE_NOTICE_TYPE, {});
}

export function startLanRemoteCreateTurn(
	pi: ExtensionAPI,
	options: {
		appDirectory: string;
		configPath: string;
		discovery: unknown;
	},
): void {
	pi.appendEntry<CreatePromptDetails>(CREATE_PROMPT_TYPE, {
		appDirectory: options.appDirectory,
	});
	pi.sendUserMessage(lanRemoteCreatePrompt(options));
}

export function lanRemoteCreatePrompt(options: {
	appDirectory: string;
	configPath: string;
	discovery: unknown;
}): string {
	return [
		CREATE_PROMPT_HEADER,
		`Project directory: ${options.appDirectory}`,
		`Config file: ${options.configPath}`,
		`Browser client source: ${CLIENT_SOURCE_PATH}`,
		`Discovery and protocol documentation (JSON): ${JSON.stringify(options.discovery)}`,
		...CREATE_PROMPT_GUIDANCE,
	].join("\n");
}

function isLanRemoteCreatePrompt(markdown: string): boolean {
	const lines = markdown.split("\n");
	return (
		lines.length === CREATE_PROMPT_GUIDANCE.length + 5 &&
		lines[0] === CREATE_PROMPT_HEADER &&
		lines[1]?.startsWith("Project directory: ") === true &&
		lines[2]?.startsWith("Config file: ") === true &&
		lines[3]?.startsWith("Browser client source: ") === true &&
		lines[4]?.startsWith("Discovery and protocol documentation (JSON): ") ===
			true &&
		CREATE_PROMPT_GUIDANCE.every((line, index) => lines[index + 5] === line)
	);
}

function remoteBox(theme: Theme, labelText: string, bodyText: string): Box {
	const label = theme.bold(theme.fg("customMessageLabel", labelText));
	const body = theme.fg("customMessageText", bodyText);
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(`${label}\n${body}`, 0, 0));
	return box;
}
