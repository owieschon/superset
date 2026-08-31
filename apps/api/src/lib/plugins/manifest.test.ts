import { describe, expect, test } from "bun:test";
import { readPath, resolveTemplate, resolveTemplateDeep } from "./manifest";

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
