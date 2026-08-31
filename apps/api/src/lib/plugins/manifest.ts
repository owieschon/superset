export const SUPERSET_EXTENSION = "superset";

export interface AuthInput {
	name: string;
	label?: string;
	placeholder?: string;
	description?: string;
	required?: boolean;
	secret?: boolean;
}

export interface AuthIdentity {
	url: string;
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: unknown;
	id: string;
	label?: string;
}

/**
 * One way to authenticate. A plugin may offer several, and they are not
 * interchangeable — Linear sends OAuth tokens as `Bearer <token>` and personal
 * API keys raw — so `identity` and `bind` belong to the method.
 */
export interface PluginAuthMethod {
	type: "oauth2" | "api_key";
	label?: string;
	provider?: string;
	inputs?: AuthInput[];
	credential_input?: string;
	authorization_url?: string;
	token_url?: string;
	scopes?: string[];
	scope_separator?: string;
	token_request_auth_method?: string;
	token_expiration_buffer?: number;
	requires_env?: string[];
	identity?: AuthIdentity;
	bind?: PluginBind;
}

export type PluginAuth = PluginAuthMethod[];

/** The declared method matching `type`, or the only one when unspecified. */
export function authMethod(
	auth: PluginAuth | undefined,
	type?: string,
): PluginAuthMethod | undefined {
	if (!auth?.length) return undefined;
	if (!type) return auth.length === 1 ? auth[0] : undefined;
	return auth.find((method) => method.type === type);
}

export interface PluginMcp {
	type: "streamable-http";
	url: string;
	headers?: Record<string, string>;
}

export interface PluginBind {
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

/** Stamped by `plugins publish`; addresses and pins the published artifact. */
export interface PluginServer {
	path?: string;
	integrity?: string;
}

export interface SupersetExtension {
	interface?: { displayName: string; category?: string; icon?: string };
	auth?: PluginAuth;
	bind?: PluginBind;
	mcp?: PluginMcp;
	server?: PluginServer;
}

export interface PluginManifest {
	name: string;
	version: string;
	description?: string;
	extensions?: Record<string, SupersetExtension>;
}

export function supersetExtension(
	manifest: PluginManifest,
): SupersetExtension | undefined {
	return manifest.extensions?.[SUPERSET_EXTENSION];
}

export interface TemplateScope {
	config?: { access_token?: string; [key: string]: unknown };
	inputs?: Record<string, unknown>;
}

const TEMPLATE = /\$\{(config|inputs)\.([\w.-]+)\}/g;

/**
 * Resolves `${config.access_token}` and `${inputs.site}` in a manifest string.
 * Only these two roots expand; anything else stays literal, so a manifest can
 * never reach into process env.
 */
export function resolveTemplate(value: string, scope: TemplateScope): string {
	return value.replace(TEMPLATE, (whole, root: string, key: string) => {
		const source =
			root === "config"
				? (scope.config as Record<string, unknown> | undefined)
				: scope.inputs;
		const resolved = source?.[key];
		return resolved === undefined || resolved === null
			? whole
			: String(resolved);
	});
}

export function resolveTemplateDeep<T>(value: T, scope: TemplateScope): T {
	if (typeof value === "string") {
		return resolveTemplate(value, scope) as unknown as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) =>
			resolveTemplateDeep(item, scope),
		) as unknown as T;
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = resolveTemplateDeep(item, scope);
		}
		return out as T;
	}
	return value;
}

/**
 * JSONPath-lite: `$.a.b[0].c`. Deliberately not full JSONPath — filters and
 * wildcards would be a parser and a dependency for capability no manifest
 * needs.
 */
export function readPath(source: unknown, path: string): unknown {
	const trimmed = path.startsWith("$.") ? path.slice(2) : path;
	let current: unknown = source;

	for (const segment of trimmed.split(".")) {
		if (current === null || current === undefined) return undefined;
		const match = segment.match(/^([^[\]]*)((?:\[\d+\])*)$/);
		if (!match) return undefined;

		const [, key, indexes] = match;
		if (key) {
			if (typeof current !== "object") return undefined;
			current = (current as Record<string, unknown>)[key];
		}
		for (const index of indexes?.match(/\d+/g) ?? []) {
			if (!Array.isArray(current)) return undefined;
			current = current[Number(index)];
		}
	}

	return current;
}

/**
 * A fetch for requests that carry a credential to a manifest-supplied URL.
 *
 * Two things the default does wrong here. It will happily dial `http://`, and
 * a manifest is remote data — the marketplace it came from is not always ours.
 * And it follows redirects, re-sending the Authorization header (or a client
 * secret in the body) to whatever host the 302 names, which turns any provider
 * with an open redirect into a credential exfiltration path.
 *
 * So: https only, and a redirect is an error rather than a second request.
 */
export async function credentialFetch(
	url: string,
	init: RequestInit,
	what: string,
): Promise<Response> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${what} URL is not a URL: ${url}`);
	}
	if (parsed.protocol !== "https:") {
		throw new Error(
			`${what} URL must be https, got ${parsed.protocol}//${parsed.host}`,
		);
	}

	const response = await fetch(url, { ...init, redirect: "manual" });
	if (response.status >= 300 && response.status < 400) {
		throw new Error(
			`${what} URL redirected to ${response.headers.get("location") ?? "an unnamed location"}; refusing to resend the credential.`,
		);
	}
	return response;
}
