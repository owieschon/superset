export type CliOptions =
	| { mode: "help" }
	| { mode: "compact" | "full" | "json"; input: string }
	| { mode: "invalid" };

export function parseCliOptions(args: string[]): CliOptions {
	if (args.includes("--help") || args.includes("-h")) return { mode: "help" };
	const json = args.includes("--json");
	const full = args.includes("--full");
	const input = args.find((arg) => !arg.startsWith("-"));
	if (
		!input ||
		args.length !== 1 + Number(json) + Number(full) ||
		(json && full)
	)
		return { mode: "invalid" };
	return { mode: json ? "json" : full ? "full" : "compact", input };
}
