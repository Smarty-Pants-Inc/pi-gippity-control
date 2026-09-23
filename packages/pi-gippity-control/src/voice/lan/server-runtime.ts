import type { Server as HttpsServer } from "node:https";
import { isIPv6 } from "node:net";
import { isLoopbackHost, LAN_ACCESS_FRAGMENT } from "./access.ts";

export async function collectFailures(
	promises: ReadonlyArray<Promise<unknown> | undefined>,
	failures: unknown[],
): Promise<void> {
	const settled = await Promise.allSettled(
		promises.filter(
			(promise): promise is Promise<unknown> => promise !== undefined,
		),
	);
	for (const result of settled)
		if (result.status === "rejected") failures.push(result.reason);
}

export function configureServer(server: HttpsServer): void {
	server.keepAliveTimeout = 20_000;
	server.on("tlsClientError", () => {});
	server.on("clientError", (_error, socket) => socket.destroy());
	server.on("error", () => {});
}

export function listen(
	server: HttpsServer,
	port: number,
	host: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

/** The origin a browser uses; loopback is reached as localhost through `ssh -L`. */
export function lanVoiceOrigin(host: string, port: number): string {
	if (isLoopbackHost(host)) return `https://localhost:${port}`;
	return `https://${isIPv6(host) ? `[${host}]` : host}:${port}`;
}

/** The token rides in the fragment, which browsers never send to a server. */
export function lanVoiceAccessUrl(origin: string, token: string): string {
	return `${origin}/#${LAN_ACCESS_FRAGMENT}=${token}`;
}
