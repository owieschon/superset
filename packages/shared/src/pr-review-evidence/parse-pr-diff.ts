import type { ChangedFile, ChangeType } from "./types";

/**
 * Patterns for files that a repository treats as tests. Deliberately short:
 * a path that doesn't match is simply not called a test file, which costs a
 * piece of evidence, where a loose pattern would mislabel source as coverage.
 */
const TEST_FILE_PATTERNS: readonly RegExp[] = [
	/(^|\/)__tests__\//,
	/\.(test|spec)\.[cm]?[jt]sx?$/,
	/(^|\/)test_[^/]+\.py$/,
	/_test\.(go|py|rb)$/,
	/(^|\/)[^/]+_spec\.rb$/,
];

export function isTestFilePath(path: string): boolean {
	return TEST_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

interface PendingFile {
	headerOldPath: string;
	headerNewPath: string;
	renameFrom: string | null;
	renameTo: string | null;
	explicitType: ChangeType | null;
	additions: number;
	deletions: number;
}

/**
 * Parses a unified diff into per-file facts.
 *
 * Only the header lines git always emits are read — `diff --git`, the file
 * mode lines, `rename from`/`rename to` — plus a count of `+`/`-` body lines.
 * A truncated patch yields the files it managed to announce and no more;
 * unparseable input yields nothing rather than a guess.
 */
export function parsePullRequestDiff(patch: string | null): ChangedFile[] {
	if (!patch) return [];

	const files: ChangedFile[] = [];
	let pending: PendingFile | null = null;

	const flush = () => {
		if (!pending) return;
		files.push(finalize(pending));
		pending = null;
	};

	for (const line of patch.split("\n")) {
		const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
		if (header?.[1] && header[2]) {
			flush();
			pending = {
				headerOldPath: header[1],
				headerNewPath: header[2],
				renameFrom: null,
				renameTo: null,
				explicitType: null,
				additions: 0,
				deletions: 0,
			};
			continue;
		}
		if (!pending) continue;

		if (line.startsWith("new file mode")) {
			pending.explicitType = "added";
		} else if (line.startsWith("deleted file mode")) {
			pending.explicitType = "deleted";
		} else if (line.startsWith("rename from ")) {
			pending.renameFrom = line.slice("rename from ".length);
		} else if (line.startsWith("rename to ")) {
			pending.renameTo = line.slice("rename to ".length);
		} else if (line.startsWith("+++") || line.startsWith("---")) {
			// File markers, not content.
		} else if (line.startsWith("+")) {
			pending.additions += 1;
		} else if (line.startsWith("-")) {
			pending.deletions += 1;
		}
	}
	flush();

	return files;
}

function finalize(pending: PendingFile): ChangedFile {
	const isRename =
		pending.renameFrom !== null &&
		pending.renameTo !== null &&
		pending.renameFrom !== pending.renameTo;
	const path = isRename
		? (pending.renameTo as string)
		: pending.explicitType === "deleted"
			? pending.headerOldPath
			: pending.headerNewPath;

	return {
		path,
		previousPath: isRename ? pending.renameFrom : null,
		changeType: isRename ? "renamed" : (pending.explicitType ?? "modified"),
		additions: pending.additions,
		deletions: pending.deletions,
		isTestFile: isTestFilePath(path),
	};
}
