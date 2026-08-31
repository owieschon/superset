import { describe, expect, test } from "bun:test";
import {
	credentialFetch,
	readPath,
	resolveTemplate,
	resolveTemplateDeep,
} from "./manifest";

const scope = {
	config: { access_token: "tok_123" },
	inputs: { site: "acme.atlassian.net" },
};

describe("resolveTemplate", () => {
	test("expands config and inputs", () => {
		expect(resolveTemplate("Bearer ${config.access_token}", scope)).toBe(
			"Bearer tok_123",
		);
		expect(resolveTemplate("https://${inputs.site}/mcp", scope)).toBe(
			"https://acme.atlassian.net/mcp",
		);
	});

	// A manifest is public and its author is not necessarily trusted. If any
	// other root expanded, `${env.X}` plus a manifest-controlled token_url
	// would read a secret and post it anywhere.
	test.each([
		"${env.DATABASE_URL}",
		"${process.env.SECRET}",
		"${globalThis.x}",
		"${secrets.token}",
	])("leaves %s literal", (template) => {
		expect(resolveTemplate(template, scope)).toBe(template);
	});

	test("leaves an unknown key under a known root literal", () => {
		expect(resolveTemplate("${config.refresh_token}", scope)).toBe(
			"${config.refresh_token}",
		);
	});

	test("resolves deeply through objects and arrays", () => {
		expect(
			resolveTemplateDeep(
				{
					headers: { Authorization: "Bearer ${config.access_token}" },
					q: ["${inputs.site}"],
				},
				scope,
			),
		).toEqual({
			headers: { Authorization: "Bearer tok_123" },
			q: ["acme.atlassian.net"],
		});
	});
});

describe("readPath", () => {
	test("reads a GitHub identity response", () => {
		const payload = { id: 17528887, login: "harshithmullapudi" };
		expect(readPath(payload, "$.id")).toBe(17528887);
		expect(readPath(payload, "$.login")).toBe("harshithmullapudi");
	});

	test("reads a nested GraphQL response", () => {
		const payload = {
			data: { viewer: { organization: { id: "org-1", name: "Tegon" } } },
		};
		expect(readPath(payload, "$.data.viewer.organization.id")).toBe("org-1");
	});

	test("indexes into arrays", () => {
		expect(
			readPath({ items: [{ id: "a" }, { id: "b" }] }, "$.items[1].id"),
		).toBe("b");
	});

	test.each([
		"$.a.b.c",
		"$.missing",
		"$.items[9].id",
	])("returns undefined for %s rather than throwing", (path) => {
		expect(readPath({ items: [] }, path)).toBeUndefined();
	});

	test("tolerates a path without the $ prefix", () => {
		expect(readPath({ a: 1 }, "a")).toBe(1);
	});
});

describe("credentialFetch", () => {
	// The manifest is remote data: the marketplace it came from is not always
	// ours, and these requests carry a client secret or a bearer token.
	test.each([
		"http://linear.app/oauth/token",
		"ftp://linear.app/token",
		"file:///etc/passwd",
	])("refuses %j", async (url) => {
		await expect(credentialFetch(url, {}, "token_url")).rejects.toThrow(
			/must be https/,
		);
	});

	test("refuses a value that is not a URL", async () => {
		await expect(credentialFetch("not a url", {}, "identity")).rejects.toThrow(
			/is not a URL/,
		);
	});

	test("refuses to follow a redirect rather than resend the credential", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(null, {
				status: 302,
				headers: { location: "https://attacker.test/collect" },
			})) as typeof fetch;

		try {
			await expect(
				credentialFetch("https://linear.app/oauth/token", {}, "token_url"),
			).rejects.toThrow(/attacker\.test/);
		} finally {
			globalThis.fetch = original;
		}
	});

	test("passes a plain https response through", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
			})) as typeof fetch;

		try {
			const response = await credentialFetch(
				"https://linear.app/oauth/token",
				{},
				"token_url",
			);
			expect(response.status).toBe(200);
		} finally {
			globalThis.fetch = original;
		}
	});
});
