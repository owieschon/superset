import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@/env";
import {
	type AuthIdentity,
	type PluginAuthMethod,
	readPath,
	resolveTemplate,
	resolveTemplateDeep,
	type TemplateScope,
} from "./manifest";

const STATE_TTL_MS = 10 * 60 * 1000;

const statePayloadSchema = z.object({
	userId: z.string().min(1),
	organizationId: z.string().min(1).nullable(),
	pluginName: z.string().min(1),
	authMethod: z.string().min(1).default("oauth2"),
	inputs: z.record(z.string(), z.string()).default({}),
	timestamp: z.number(),
});

export type PluginState = z.infer<typeof statePayloadSchema>;

export function createPluginState(
	payload: Omit<PluginState, "timestamp">,
): string {
	const body = Buffer.from(
		JSON.stringify({ ...payload, timestamp: Date.now() }),
	).toString("base64url");
	const signature = createHmac("sha256", env.BETTER_AUTH_SECRET)
		.update(body)
		.digest("base64url");
	return `${body}.${signature}`;
}

export function verifyPluginState(token: string): PluginState | null {
	const [body, signature] = token.split(".");
	if (!body || !signature) return null;

	const expected = createHmac("sha256", env.BETTER_AUTH_SECRET)
		.update(body)
		.digest("base64url");
	const a = Buffer.from(signature);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

	const parsed = statePayloadSchema.safeParse(
		JSON.parse(Buffer.from(body, "base64url").toString()),
	);
	if (!parsed.success) return null;
	if (Date.now() - parsed.data.timestamp > STATE_TTL_MS) return null;

	return parsed.data;
}

/**
 * Per-deployment client credentials, keyed by plugin name. Deliberately not in
 * the manifest: a marketplace is public, these are not.
 */
export function clientCredentials(pluginName: string): {
	clientId: string;
	clientSecret: string;
} | null {
	const slug = pluginName.toUpperCase().replace(/[.-]/g, "_");
	const clientId = process.env[`PLUGIN_${slug}_CLIENT_ID`];
	const clientSecret = process.env[`PLUGIN_${slug}_CLIENT_SECRET`];
	return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Every plugin's callback sits under one prefix so a provider OAuth app can
 * register `/api/plugins/callback` once and cover every plugin backed by it —
 * GitHub matches a redirect URL when its path is a subdirectory of the
 * registered callback. Apps with wildcard matching disabled register the exact
 * per-plugin URL instead.
 */
export function redirectUri(pluginName: string): string {
	return `${env.NEXT_PUBLIC_API_URL}/api/plugins/callback/${pluginName}`;
}

export function buildAuthorizationUrl(
	pluginName: string,
	auth: PluginAuthMethod,
	scope: TemplateScope,
	state: string,
): string {
	const credentials = clientCredentials(pluginName);
	if (!credentials) {
		throw new Error(`No OAuth client configured for plugin "${pluginName}".`);
	}
	if (!auth.authorization_url) {
		throw new Error(`Plugin "${pluginName}" declares no authorization_url.`);
	}

	const url = new URL(resolveTemplate(auth.authorization_url, scope));
	url.searchParams.set("client_id", credentials.clientId);
	url.searchParams.set("redirect_uri", redirectUri(pluginName));
	url.searchParams.set("response_type", "code");
	url.searchParams.set("state", state);
	if (auth.scopes?.length) {
		url.searchParams.set(
			"scope",
			auth.scopes.join(auth.scope_separator ?? " "),
		);
	}
	return url.toString();
}

export interface ExchangedToken {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: Date | null;
	scopes: string[] | null;
}

export async function exchangeCode(
	pluginName: string,
	auth: PluginAuthMethod,
	scope: TemplateScope,
	code: string,
): Promise<ExchangedToken> {
	const credentials = clientCredentials(pluginName);
	if (!credentials) {
		throw new Error(`No OAuth client configured for plugin "${pluginName}".`);
	}
	if (!auth.token_url) {
		throw new Error(`Plugin "${pluginName}" declares no token_url.`);
	}

	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri(pluginName),
	});

	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};

	if (auth.token_request_auth_method === "client_secret_basic") {
		const basic = Buffer.from(
			`${credentials.clientId}:${credentials.clientSecret}`,
		).toString("base64");
		headers.Authorization = `Basic ${basic}`;
	} else {
		body.set("client_id", credentials.clientId);
		body.set("client_secret", credentials.clientSecret);
	}

	const response = await fetch(resolveTemplate(auth.token_url, scope), {
		method: "POST",
		headers,
		body,
	});

	if (!response.ok) {
		throw new Error(
			`Token exchange failed: ${response.status} ${await response.text()}`,
		);
	}

	const payload = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		scope?: string;
		error?: string;
		error_description?: string;
	};

	if (payload.error || !payload.access_token) {
		throw new Error(
			payload.error_description ?? payload.error ?? "No access_token returned",
		);
	}

	const bufferSeconds = auth.token_expiration_buffer ?? 0;
	return {
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token ?? null,
		expiresAt: payload.expires_in
			? new Date(Date.now() + (payload.expires_in - bufferSeconds) * 1000)
			: null,
		scopes: payload.scope
			? payload.scope.split(auth.scope_separator ?? " ").filter(Boolean)
			: (auth.scopes ?? null),
	};
}

export interface ResolvedIdentity {
	id: string;
	label: string | null;
}

/**
 * Runs the manifest's identity request to learn which external account this
 * connection belongs to. A plugin that declares none gets a generated id and
 * no label — enough to key a row, not enough to tell two accounts apart.
 */
export async function resolveIdentity(
	identity: AuthIdentity | undefined,
	scope: TemplateScope,
): Promise<ResolvedIdentity> {
	if (!identity) return { id: randomUUID(), label: null };

	const method = identity.method ?? "GET";
	const headers = resolveTemplateDeep(identity.headers ?? {}, scope);
	const response = await fetch(resolveTemplate(identity.url, scope), {
		method,
		headers,
		body:
			method === "POST" && identity.body !== undefined
				? JSON.stringify(resolveTemplateDeep(identity.body, scope))
				: undefined,
	});

	if (!response.ok) {
		throw new Error(
			`Identity request failed: ${response.status} ${response.statusText}`,
		);
	}

	const payload = await response.json();
	const id = readPath(payload, identity.id);
	if (id === undefined || id === null || id === "") {
		throw new Error(`Identity response has nothing at ${identity.id}`);
	}

	const label = identity.label ? readPath(payload, identity.label) : null;
	return {
		id: String(id),
		label: label === undefined || label === null ? null : String(label),
	};
}
