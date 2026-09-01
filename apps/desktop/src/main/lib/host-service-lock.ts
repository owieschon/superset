import { randomUUID } from "node:crypto";
import {
	closeSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { getHostId } from "@superset/shared/host-info";
import { isProcessAlive, manifestDir } from "./host-service-manifest";

/**
 * Cross-instance spawn lock for a per-org host-service.
 *
 * Multiple Superset app instances share one `$SUPERSET_HOME_DIR`, so their
 * in-process `pendingStarts` maps can't stop two instances from spawning the
 * same org's host-service at once. This atomic exclusive-create lockfile
 * single-flights the spawn+health-check critical section across processes.
 *
 * The lock records the *app instance's* pid (Electron main), not the child's —
 * its liveness tracks the spawner so a crashed instance's lock can be stolen.
 */
export interface SpawnLock {
	ownerPid: number;
	machineId: string;
	acquiredAt: number;
	path?: string;
}

export interface SpawnLockHandle {
	release(): void;
}

function lockPath(organizationId: string): string {
	return join(manifestDir(organizationId), "spawn.lock");
}

export function readSpawnLock(organizationId: string): SpawnLock | null {
	try {
		const raw = readFileSync(lockPath(organizationId), "utf-8");
		const data = JSON.parse(raw);
		if (
			typeof data.ownerPid !== "number" ||
			typeof data.machineId !== "string" ||
			typeof data.acquiredAt !== "number"
		) {
			return null;
		}
		return data as SpawnLock;
	} catch {
		return null;
	}
}

function removeLock(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone — fine.
	}
}

function tryCreateLock(organizationId: string): SpawnLockHandle | null {
	const canonicalPath = lockPath(organizationId);
	const ownedPath = `${canonicalPath}.${randomUUID()}`;
	try {
		mkdirSync(manifestDir(organizationId), { recursive: true, mode: 0o700 });
	} catch {
		// Best-effort; openSync below surfaces a real failure.
	}

	let fd: number;
	try {
		// "wx" = O_CREAT | O_EXCL: atomic exclusive create on POSIX and Windows.
		fd = openSync(ownedPath, "wx", 0o600);
	} catch {
		return null;
	}

	try {
		const lock: SpawnLock = {
			ownerPid: process.pid,
			machineId: getHostId(),
			acquiredAt: Date.now(),
			path: ownedPath,
		};
		writeSync(fd, JSON.stringify(lock));
		// The handle owns the unique path, so a stale takeover cannot redirect
		// its release to a successor.
		try {
			linkSync(ownedPath, canonicalPath);
		} catch {
			removeLock(ownedPath);
			return null;
		}
	} finally {
		try {
			// Best-effort close; the lock's existence, not the fd, is what matters.
			closeSync(fd);
		} catch {}
	}

	return {
		release() {
			try {
				// The inode check prevents a displaced handle from removing a
				// successor. A replacement between stat and unlink remains a small
				// filesystem TOCTOU boundary; the handle never needs that pathname
				// for ownership, and its private path is always safe to remove.
				if (statSync(canonicalPath).ino === statSync(ownedPath).ino) {
					removeLock(canonicalPath);
				}
			} catch {}
			removeLock(ownedPath);
		},
	};
}

/**
 * Acquire the per-org spawn lock, stealing it when the current holder has
 * crashed or wedged. Returns a handle on success, or `null` when a live
 * instance is legitimately mid-spawn (the caller should wait and retry).
 */
export function acquireSpawnLock(
	organizationId: string,
	{ staleMs }: { staleMs: number },
): SpawnLockHandle | null {
	const handle = tryCreateLock(organizationId);
	if (handle) return handle;

	// Lock exists — decide whether the holder is dead/wedged and stealable.
	const existing = readSpawnLock(organizationId);
	const stealable =
		!existing || // garbage / partial write
		!isProcessAlive(existing.ownerPid) || // owner crashed mid-spawn
		Date.now() - existing.acquiredAt > staleMs; // owner wedged

	if (!stealable) return null;

	removeLock(lockPath(organizationId));
	if (existing?.path?.startsWith(`${lockPath(organizationId)}.`)) {
		removeLock(existing.path);
	}
	// One retry after stealing; if a third party grabbed it first, back off.
	return tryCreateLock(organizationId);
}
