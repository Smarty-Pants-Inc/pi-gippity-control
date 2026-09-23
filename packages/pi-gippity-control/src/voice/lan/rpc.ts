import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { remoteJsonValue } from "./remote-json.ts";

/**
 * Remote apps may call only these methods. The bundled UI calls none of them.
 * `pi.exec`, `sendUserMessage` (use /api/send), provider and tool changes,
 * `shutdown` and every dotted path (for example
 * `modelRegistry.getProviderAuth`, which returns API keys) stay unreachable.
 */
export const LAN_REMOTE_RPC_ALLOWLIST: Readonly<
	Record<LanRemoteRpcRequest["target"], ReadonlySet<string>>
> = {
	pi: new Set([
		"getSessionName",
		"setSessionName",
		"getThinkingLevel",
		"setThinkingLevel",
		"getActiveTools",
		"getCommands",
	]),
	context: new Set([
		"isIdle",
		"hasPendingMessages",
		"getContextUsage",
		"abort",
		"compact",
	]),
};

export interface LanRemoteRpcRequest {
	id?: string | number | null;
	target: "pi" | "context";
	method: string;
	args: unknown[];
}

export function decodeLanRemoteRpcRequest(
	value: Record<string, unknown>,
): LanRemoteRpcRequest {
	const target = value["target"];
	const method = value["method"];
	const args = value["args"] ?? [];
	if (target !== "pi" && target !== "context")
		throw new Error('RPC target must be "pi" or "context"');
	if (typeof method !== "string" || !method || method.length > 128)
		throw new Error("RPC method is invalid");
	const path = method.split(".");
	if (
		path.some(
			(part) =>
				!part ||
				part === "constructor" ||
				part === "prototype" ||
				part === "__proto__",
		)
	)
		throw new Error("RPC method is invalid");
	if (!LAN_REMOTE_RPC_ALLOWLIST[target].has(method))
		throw new Error(`RPC method ${target}.${method} is not allowed`);
	if (!Array.isArray(args)) throw new Error("RPC args must be an array");
	const id = value["id"];
	if (
		id !== undefined &&
		id !== null &&
		typeof id !== "string" &&
		typeof id !== "number"
	)
		throw new Error("RPC id must be a string, number, or null");
	return {
		...(id !== undefined ? { id } : {}),
		target,
		method,
		args,
	};
}

export async function invokeLanRemoteRpc(options: {
	request: LanRemoteRpcRequest;
	pi: ExtensionAPI;
	ctx: ExtensionContext;
}): Promise<unknown> {
	const { request } = options;
	const target = request.target === "pi" ? options.pi : options.ctx;
	const path = request.method.split(".");
	let owner: unknown = target;
	for (const part of path.slice(0, -1)) {
		if (!owner || (typeof owner !== "object" && typeof owner !== "function"))
			break;
		owner = (owner as Record<string, unknown>)[part];
	}
	const method =
		owner && (typeof owner === "object" || typeof owner === "function")
			? (owner as Record<string, unknown>)[path.at(-1)!]
			: undefined;
	if (typeof method !== "function")
		throw new Error(
			`${request.target}.${request.method} is not available in this Pi context`,
		);
	return remoteJsonValue(await method.apply(owner, request.args));
}

export function lanRemoteRpcError(error: unknown): {
	name: string;
	message: string;
} {
	return error instanceof Error
		? { name: error.name, message: error.message }
		: { name: "Error", message: String(error) };
}
