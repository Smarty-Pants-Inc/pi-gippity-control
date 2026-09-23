import { spawn } from "node:child_process";

const OPENER_TIMEOUT_MS = 30_000;

/**
 * Runs the configured page opener (for example an ssh command that opens the
 * page on another computer). The argv runs without a shell. The URL, which
 * carries the access token, is written to the opener's stdin and never put in
 * argv, where other accounts on the host could read it.
 */
export function runLanOpener(
	argv: readonly string[],
	url: string,
	timeoutMs = OPENER_TIMEOUT_MS,
): Promise<void> {
	const [command, ...args] = argv;
	if (!command) return Promise.reject(new Error("lan.openCommand is empty"));
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["pipe", "ignore", "pipe"],
			windowsHide: true,
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-500);
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("The page opener timed out"));
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`The page opener failed (${signal ?? `exit ${code}`})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
					),
				);
		});
		child.stdin.on("error", () => {});
		child.stdin.end(`${url}\n`);
	});
}
