import { CLIError } from "@superset/cli-framework";
import { getApiUrl } from "../config";

/**
 * Mirrors the header rule in api-client: better-auth's apiKey plugin reads
 * `sk_live_…` from x-api-key, and rejects it as an invalid bearer.
 */
function authHeaders(bearer: string): Record<string, string> {
	return bearer.startsWith("sk_live_")
		? { "x-api-key": bearer }
		: { Authorization: `Bearer ${bearer}` };
}

export async function apiRequest<T>(
	bearer: string,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const response = await fetch(`${getApiUrl()}${path}`, {
		...init,
		headers: { ...authHeaders(bearer), ...(init?.headers ?? {}) },
	});

	const text = await response.text();
	let payload: unknown;
	try {
		payload = text ? JSON.parse(text) : {};
	} catch {
		throw new CLIError(
			`${path} returned ${response.status} with a non-JSON body: ${text.slice(0, 200)}`,
		);
	}

	if (!response.ok) {
		const message = (payload as { error?: string }).error;
		throw new CLIError(message ?? `${path} returned ${response.status}`);
	}
	return payload as T;
}

/**
 * Both mcp commands address a plugin by connection id, and the id only comes
 * from one place — so a wrong or stale one should name that place rather than
 * leaving the caller to guess which of several ids the API meant.
 */
export async function connectionRequest<T>(
	bearer: string,
	path: string,
	init?: RequestInit,
): Promise<T> {
	try {
		return await apiRequest<T>(bearer, path, init);
	} catch (error) {
		if (
			error instanceof CLIError &&
			/connection not found/i.test(error.message)
		) {
			throw new CLIError(
				error.message,
				"Run: superset plugins list  (the pluginId column holds the id)",
			);
		}
		throw error;
	}
}

export interface AuthInputSpec {
	name: string;
	label?: string;
	description?: string;
	required?: boolean;
	secret?: boolean;
}

/**
 * The message an agent reads when a plugin needs credentials it was not given.
 * It names each question to ask and the exact command to run with the answers,
 * so the agent can collect them and retry without guessing at the interface.
 */
export function missingInputsError(
	pluginName: string,
	missing: AuthInputSpec[],
	all: AuthInputSpec[],
): CLIError {
	const describe = (input: AuthInputSpec) => {
		const flags = [
			input.required ? "required" : "optional",
			input.secret ? "secret" : null,
		]
			.filter(Boolean)
			.join(", ");
		return `  ${input.name.padEnd(16)} ${input.label ?? input.name} (${flags})${
			input.description ? `\n  ${" ".repeat(16)} ${input.description}` : ""
		}`;
	};

	const example = Object.fromEntries(
		all.map((input) => [input.name, `<${input.name}>`]),
	);

	return new CLIError(
		[
			`"${pluginName}" needs credentials before its tools work.`,
			"",
			"Ask the user for:",
			...missing.map(describe),
			"",
			"Then run:",
			`  superset plugins connect ${pluginName} --inputs '${JSON.stringify(example)}'`,
			"",
			"Values marked secret appear in shell history and process listings; prefer",
			"--inputs - to read the JSON from stdin.",
		].join("\n"),
	);
}

export function parseInputs(
	raw: string | undefined,
	stdin: string | null,
): Record<string, string> {
	const source = raw === "-" ? stdin : raw;
	if (!source) return {};
	try {
		const parsed = JSON.parse(source) as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(parsed).map(([key, value]) => [key, String(value)]),
		);
	} catch (error) {
		throw new CLIError(
			`--inputs must be a JSON object: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function readStdin(): Promise<string | null> {
	if (process.stdin.isTTY) return null;
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8").trim();
	return text || null;
}
