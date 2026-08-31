import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";

mock.module("@/env", () => ({
	env: {
		BETTER_AUTH_SECRET: "test-secret",
		NEXT_PUBLIC_API_URL: "https://api.test",
	},
}));

const {
	buildAuthorizationUrl,
	clientCredentials,
	createPluginState,
	redirectUri,
	verifyPluginState,
} = await import("./oauth");

const PAYLOAD = {
	userId: "user_1",
	organizationId: "org_1",
	pluginName: "linear",
	authMethod: "oauth2",
	inputs: {},
};

describe("plugin oauth state", () => {
	test("round-trips the payload it was created with", () => {
		const state = verifyPluginState(createPluginState(PAYLOAD));
		expect(state).toMatchObject(PAYLOAD);
	});

	// The state is what the callback checks the session against, so forging one
	// is forging "who started this flow" — the callback would otherwise bind a
	// provider account to whatever user id the attacker named.
	test("rejects a tampered payload carrying a valid-looking signature", () => {
		const [, signature] = createPluginState(PAYLOAD).split(".");
		const forged = Buffer.from(
			JSON.stringify({ ...PAYLOAD, userId: "victim", timestamp: Date.now() }),
		).toString("base64url");

		expect(verifyPluginState(`${forged}.${signature}`)).toBeNull();
	});

	test("rejects a signature from a different secret", () => {
		const token = createPluginState(PAYLOAD);
		const [body] = token.split(".");
		const wrong = createHmac("sha256", "other-secret")
			.update(body)
			.digest("base64url");

		expect(verifyPluginState(`${body}.${wrong}`)).toBeNull();
	});

	test.each([
		["no separator"],
		[".sig"],
		["body."],
		[""],
	])("rejects the malformed token %j", (token) => {
		expect(verifyPluginState(token)).toBeNull();
	});

	test("rejects a state older than its ten-minute window", () => {
		const body = Buffer.from(
			JSON.stringify({ ...PAYLOAD, timestamp: Date.now() - 11 * 60 * 1000 }),
		).toString("base64url");
		const signature = createHmac("sha256", "test-secret")
			.update(body)
			.digest("base64url");

		expect(verifyPluginState(`${body}.${signature}`)).toBeNull();
	});
});

describe("clientCredentials", () => {
	const vars = ["PLUGIN_LINEAR_CLIENT_ID", "PLUGIN_LINEAR_CLIENT_SECRET"];
	const saved = new Map(vars.map((name) => [name, process.env[name]]));

	afterEach(() => {
		for (const name of vars) {
			const value = saved.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	test("reads the per-plugin env pair", () => {
		process.env.PLUGIN_LINEAR_CLIENT_ID = "id";
		process.env.PLUGIN_LINEAR_CLIENT_SECRET = "secret";

		expect(clientCredentials("linear")).toEqual({
			clientId: "id",
			clientSecret: "secret",
		});
	});

	// A half-configured deployment must read as unconfigured, not send an
	// authorization request missing its secret.
	test("returns null when only one half is set", () => {
		process.env.PLUGIN_LINEAR_CLIENT_ID = "id";
		delete process.env.PLUGIN_LINEAR_CLIENT_SECRET;

		expect(clientCredentials("linear")).toBeNull();
	});

	test("maps dots and dashes in a plugin name to underscores", () => {
		process.env.PLUGIN_CHROME_DEVTOOLS_CLIENT_ID = "id";
		process.env.PLUGIN_CHROME_DEVTOOLS_CLIENT_SECRET = "secret";

		expect(clientCredentials("chrome-devtools")).not.toBeNull();

		delete process.env.PLUGIN_CHROME_DEVTOOLS_CLIENT_ID;
		delete process.env.PLUGIN_CHROME_DEVTOOLS_CLIENT_SECRET;
	});
});

describe("buildAuthorizationUrl", () => {
	beforeEach(() => {
		process.env.PLUGIN_LINEAR_CLIENT_ID = "id";
		process.env.PLUGIN_LINEAR_CLIENT_SECRET = "secret";
	});

	afterEach(() => {
		delete process.env.PLUGIN_LINEAR_CLIENT_ID;
		delete process.env.PLUGIN_LINEAR_CLIENT_SECRET;
	});

	const auth = {
		type: "oauth2" as const,
		authorization_url: "https://linear.app/oauth/authorize",
		scopes: ["read", "write"],
		scope_separator: ",",
	};

	test("carries the client id, redirect, and state", () => {
		const url = new URL(
			buildAuthorizationUrl("linear", auth, { inputs: {} }, "state-token"),
		);

		expect(url.searchParams.get("client_id")).toBe("id");
		expect(url.searchParams.get("state")).toBe("state-token");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("redirect_uri")).toBe(redirectUri("linear"));
	});

	// Linear rejects space-separated scopes; the separator is per-provider.
	test("joins scopes with the manifest's separator", () => {
		const url = new URL(
			buildAuthorizationUrl("linear", auth, { inputs: {} }, "s"),
		);
		expect(url.searchParams.get("scope")).toBe("read,write");
	});

	test("defaults the separator to a space", () => {
		const url = new URL(
			buildAuthorizationUrl(
				"linear",
				{ ...auth, scope_separator: undefined },
				{ inputs: {} },
				"s",
			),
		);
		expect(url.searchParams.get("scope")).toBe("read write");
	});

	test("refuses to build a URL for an unconfigured plugin", () => {
		delete process.env.PLUGIN_LINEAR_CLIENT_SECRET;
		expect(() =>
			buildAuthorizationUrl("linear", auth, { inputs: {} }, "s"),
		).toThrow(/No OAuth client configured/);
	});

	test("every plugin's callback sits under one registerable prefix", () => {
		expect(redirectUri("linear")).toBe(
			"https://api.test/api/plugins/callback/linear",
		);
	});
});
