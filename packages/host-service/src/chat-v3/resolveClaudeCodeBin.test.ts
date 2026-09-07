import { describe, expect, test } from "bun:test";
import {
	correctForAsarUnpack,
	resolveClaudeCodeBin,
} from "./resolveClaudeCodeBin";

describe("resolveClaudeCodeBin", () => {
	test("prefers an explicit path over resolving one", () => {
		const bin = resolveClaudeCodeBin({
			explicit: "/custom/claude",
			resolve: () => {
				throw new Error("should not be called");
			},
		});
		expect(bin).toBe("/custom/claude");
	});

	test("resolves the platform/arch-specific package for the given target", () => {
		let requested: string | undefined;
		const bin = resolveClaudeCodeBin({
			platform: "darwin",
			arch: "arm64",
			resolve: (specifier) => {
				requested = specifier;
				return "/repo/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
			},
			exists: () => false,
		});
		expect(requested).toBe(
			"@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
		);
		expect(bin).toBe(
			"/repo/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
		);
	});

	test("appends .exe on win32", () => {
		let requested: string | undefined;
		resolveClaudeCodeBin({
			platform: "win32",
			arch: "x64",
			resolve: (specifier) => {
				requested = specifier;
				return "C:\\claude.exe";
			},
			exists: () => false,
		});
		expect(requested).toBe(
			"@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
		);
	});

	test("returns undefined when resolution throws (binary not installed)", () => {
		const bin = resolveClaudeCodeBin({
			resolve: () => {
				throw new Error("not found");
			},
		});
		expect(bin).toBeUndefined();
	});
});

describe("correctForAsarUnpack", () => {
	test("leaves ordinary (non-asar) paths untouched", () => {
		const path =
			"/repo/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
		expect(correctForAsarUnpack(path, () => true)).toBe(path);
	});

	// The real, reproduced failure: `require.resolve` from inside the
	// packaged desktop app returns a path through `app.asar` -- a single
	// archive file on disk, not a real directory -- which `child_process
	// .spawn` cannot execve() into (`ENOTDIR`), even though the native
	// binary was unpacked to a real `app.asar.unpacked` sibling.
	test("redirects a resolved app.asar path to its app.asar.unpacked sibling when it exists", () => {
		const packed =
			"/Applications/Superset.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
		const unpacked =
			"/Applications/Superset.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
		const exists = (p: string) => p === unpacked;
		expect(correctForAsarUnpack(packed, exists)).toBe(unpacked);
	});

	test("falls back to the packed path when no unpacked sibling exists", () => {
		const packed =
			"/Applications/Superset.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
		expect(correctForAsarUnpack(packed, () => false)).toBe(packed);
	});
});
