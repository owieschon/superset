import fs from "node:fs";

/**
 * Path a replacement is staged at before being renamed into place. The pid
 * keeps two provisioners on one machine (the desktop plus one CLI host-service
 * per org) from staging over each other.
 */
export function pendingWritePath(filePath: string): string {
	return `${filePath}.${process.pid}.tmp`;
}

/**
 * True for a path some `writeFileIfChanged` call is currently staging a write
 * at. Anything that deletes unrecognized files from a directory this writes
 * into must skip these: removing another process's staged file makes its
 * rename fail, and the file it was replacing is left stale.
 */
export function isPendingWritePath(filePath: string): boolean {
	return /\.\d+\.tmp$/.test(filePath);
}

/**
 * Idempotent, atomic file write. Skips the write when content is unchanged
 * (callers rely on this to keep re-provisioning from churning mtimes), and
 * writes via temp-file + rename otherwise. Atomicity matters because several
 * provisioners can run concurrently on one machine (the desktop plus one CLI
 * host-service per org), and some targets are user-owned configs
 * (~/.claude/settings.json) where a torn write would break the user's agent
 * until they repair it by hand — the managed-hooks merge skips unparseable
 * files rather than rewriting them.
 */
export function writeFileIfChanged(
	filePath: string,
	content: string | Uint8Array,
	mode: number,
): boolean {
	const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
	const next = Buffer.from(content);
	if (existing?.equals(next)) {
		try {
			fs.chmodSync(filePath, mode);
		} catch {
			// Best effort.
		}
		return false;
	}

	const tmpPath = pendingWritePath(filePath);
	try {
		fs.writeFileSync(tmpPath, next, { mode });
		fs.renameSync(tmpPath, filePath);
	} catch (error) {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// Best effort.
		}
		throw error;
	}
	try {
		fs.chmodSync(filePath, mode);
	} catch {
		// Best effort.
	}
	return true;
}
