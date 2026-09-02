import type { ChangedFile } from "./types";

/**
 * A line of a pull-request description only counts as a testing claim if it
 * says something about testing *and* names something concrete. "Tested it by
 * hand" names nothing, so there is nothing to corroborate and it is ignored
 * rather than reported.
 */
const TESTING_KEYWORD =
	/\b(tests?|tested|testing|spec|specs|typecheck|typechecks|lint|coverage)\b/i;

/** Markdown list bullets, task-list boxes and heading markers. */
const LINE_PREFIX = /^\s*(?:[-*+]\s+)?(?:\[[ xX]\]\s+)?|^\s*#+\s+/;

export interface TestingClaim {
	/** The line, with markdown bullet/checkbox/heading markers removed. */
	text: string;
	/** Whole backtick spans, e.g. `typecheck` — the only check-name matches. */
	codeSpans: string[];
	/** Path-shaped tokens found anywhere on the line. */
	pathTokens: string[];
}

export function extractTestingClaims(body: string | null): TestingClaim[] {
	if (!body) return [];

	const claims: TestingClaim[] = [];
	for (const raw of body.split("\n")) {
		const text = raw.replace(LINE_PREFIX, "").trim();
		if (!text || !TESTING_KEYWORD.test(text)) continue;

		const codeSpans = Array.from(text.matchAll(/`([^`]+)`/g))
			.map((match) => match[1]?.trim() ?? "")
			.filter(Boolean);
		const pathTokens = Array.from(
			new Set(
				[text, ...codeSpans]
					.flatMap((source) => source.replace(/`/g, " ").split(/[\s,;()"']+/))
					.map(normalizePathToken)
					.filter(isPathShaped),
			),
		);

		// Nothing concrete was named — not a claim we can settle either way.
		if (codeSpans.length === 0 && pathTokens.length === 0) continue;
		claims.push({ text, codeSpans, pathTokens });
	}
	return claims;
}

/**
 * Strips sentence punctuation, then the repo-root prefixes people write paths
 * with — `./src/a.ts` and `/src/a.ts` name the same file as `src/a.ts`. Only
 * these two leading forms are removed; nothing else about the path is
 * rewritten, so a token still has to name a real changed path to corroborate
 * anything.
 */
function normalizePathToken(token: string): string {
	const trimmed = token.replace(/^[.,:;]+|[.,:;]+$/g, "");
	if (trimmed.startsWith("./")) return trimmed.slice(2);
	if (trimmed.startsWith("/")) return trimmed.slice(1);
	return trimmed;
}

/** A token is path-shaped when it has a directory separator and an extension. */
function isPathShaped(token: string): boolean {
	return token.includes("/") && /\.[A-Za-z0-9]+$/.test(token);
}

/**
 * A claim's token corroborates only against a file this pull request actually
 * changes — the token must be the whole path or a trailing path segment of
 * one, so `format-tokens.test.ts` matches but `tokens.ts` does not match
 * `format-tokens.ts`.
 */
export function matchChangedFile(
	claim: TestingClaim,
	files: readonly ChangedFile[],
): ChangedFile | null {
	for (const token of claim.pathTokens) {
		const match = files.find(
			(file) => file.path === token || file.path.endsWith(`/${token}`),
		);
		if (match) return match;
	}
	return null;
}
