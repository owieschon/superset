import { describe, expect, test } from "bun:test";
import path from "node:path";
import { assertSafeSegment, parsePluginRef } from "./host";
import { bumpVersion, compareVersions } from "./marketplace";

describe("assertSafeSegment", () => {
	// These values are marketplace-controlled and reach path.join, which
	// normalizes `..`. The joined path is then rmSync'd recursively, so an
	// escape here deletes an arbitrary directory.
	test.each([
		"1.0.0/../../../../../Documents",
		"../../etc",
		"..",
		"foo/../bar",
		"a/b",
		"/absolute",
		".hidden",
		"",
	])("rejects %j", (value) => {
		expect(() => assertSafeSegment(value, "version")).toThrow();
	});

	test.each([
		"1.0.0",
		"2.1.3-beta.1",
		"chrome-devtools",
		"superset",
		"a_b",
	])("allows %j", (value) => {
		expect(assertSafeSegment(value, "version")).toBe(value);
	});

	test("a rejected segment can never escape the root it is joined to", () => {
		const root = "/cache";
		for (const attack of ["../..", "1.0.0/../../.."]) {
			expect(() => assertSafeSegment(attack, "version")).toThrow();
		}
		expect(path.join(root, assertSafeSegment("1.0.0", "version"))).toBe(
			"/cache/1.0.0",
		);
	});
});

describe("containment", () => {
	// A prefix check without the separator passes for a sibling directory whose
	// name merely starts with the root: ".../foo" vs ".../foo-evil".
	test("a sibling with a shared prefix is outside the root", () => {
		const root = path.resolve("/tmp/marketplaces/foo");
		const sibling = path.resolve(root, "../foo-evil/payload");

		expect(sibling.startsWith(root)).toBe(true);
		expect(sibling.startsWith(`${root}${path.sep}`)).toBe(false);
	});

	test("a real child is inside the root", () => {
		const root = path.resolve("/tmp/marketplaces/foo");
		const child = path.resolve(root, "./plugins/linear");
		expect(child.startsWith(`${root}${path.sep}`)).toBe(true);
	});
});

describe("compareVersions", () => {
	test("orders by numeric component, not lexically", () => {
		expect(compareVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
		expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
	});

	test("treats missing components as zero", () => {
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
	});
});

describe("bumpVersion", () => {
	test.each([
		["1.2.3", "patch", "1.2.4"],
		["1.2.3", "minor", "1.3.0"],
		["1.2.3", "major", "2.0.0"],
	] as const)("%s %s → %s", (version, level, expected) => {
		expect(bumpVersion(version, level)).toBe(expected);
	});

	test("rejects a non-semver version", () => {
		expect(() => bumpVersion("latest", "patch")).toThrow();
	});
});

describe("parsePluginRef", () => {
	test("splits name@marketplace", () => {
		expect(parsePluginRef("linear@superset")).toEqual({
			name: "linear",
			marketplace: "superset",
		});
	});

	test("leaves a bare name alone", () => {
		expect(parsePluginRef("linear")).toEqual({ name: "linear" });
	});

	test("does not treat a leading @ as a separator", () => {
		expect(parsePluginRef("@scoped")).toEqual({ name: "@scoped" });
	});
});
