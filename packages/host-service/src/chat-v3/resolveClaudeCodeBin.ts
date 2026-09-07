import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { sep } from "node:path";

/**
 * `pathToClaudeCodeExecutable` for the real `claude-code` harness.
 *
 * When this is left `undefined`, `@anthropic-ai/claude-agent-sdk`'s `query()`
 * resolves its own default by `require.resolve`ing the platform-specific
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` package relative to its
 * own bundled module (see `sdk.mjs`). That self-location works for the CLI
 * and any other unpackaged/dev layout, but breaks inside the packaged
 * desktop app: `require.resolve` there returns a path *inside* `app.asar` (a
 * single archive file Electron's patched `fs` module reads transparently),
 * while `child_process.spawn` -- which does not go through that shim --
 * cannot execve() a path that runs through `app.asar` as though it were a
 * directory. The syscall fails with `ENOTDIR`, even though electron-builder
 * already unpacked the native `claude` binary to a real `app.asar.unpacked`
 * sibling on disk for exactly this reason. So host-service has to resolve
 * the binary itself and correct for that unpack case before ever handing a
 * path to the SDK, instead of leaving `pathToClaudeCodeExecutable` unset and
 * trusting the SDK's own resolution.
 *
 * `SUPERSET_CHAT_V3_CLAUDE_BIN` (set today only by the desktop app's dev-mode
 * coordinator, see `apps/desktop/src/main/lib/host-service-coordinator.ts`)
 * still wins when present -- this is a fallback for every other caller,
 * packaged desktop included.
 */
export function resolveClaudeCodeBin(options?: {
	explicit?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	resolve?: (specifier: string) => string;
	exists?: (path: string) => boolean;
}): string | undefined {
	const explicit = options?.explicit ?? process.env.SUPERSET_CHAT_V3_CLAUDE_BIN;
	if (explicit) return explicit;

	const platform = options?.platform ?? process.platform;
	const arch = options?.arch ?? process.arch;
	const exists = options?.exists ?? existsSync;
	const resolve =
		options?.resolve ??
		((specifier: string) => createRequire(import.meta.url).resolve(specifier));

	const ext = platform === "win32" ? ".exe" : "";
	const specifier = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${ext}`;

	let resolved: string;
	try {
		resolved = resolve(specifier);
	} catch {
		return undefined;
	}

	return correctForAsarUnpack(resolved, exists);
}

/**
 * Exported separately so the asar-unpack correction can be unit tested
 * without needing a real `require.resolve`.
 */
export function correctForAsarUnpack(
	resolvedPath: string,
	exists: (path: string) => boolean = existsSync,
): string {
	const packedMarker = `${sep}app.asar${sep}`;
	if (!resolvedPath.includes(packedMarker)) return resolvedPath;
	const unpacked = resolvedPath.replace(
		packedMarker,
		`${sep}app.asar.unpacked${sep}`,
	);
	return exists(unpacked) ? unpacked : resolvedPath;
}
