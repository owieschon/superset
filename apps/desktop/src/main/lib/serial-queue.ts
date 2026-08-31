/**
 * Runs async work one at a time, in the order it was handed over.
 *
 * For side effects that converge shared state rather than compute a value:
 * each run writes a desired set and removes what is not in it, so two
 * overlapping runs fight over the same directories and the one that started
 * first can finish last. Serializing is what makes the most recent call the
 * one whose result survives.
 *
 * A rejected job does not stall the queue or surface here — callers that want
 * the outcome await the returned promise.
 */
export function createSerialQueue(): (
	job: () => Promise<void>,
) => Promise<void> {
	let tail: Promise<void> = Promise.resolve();

	return (job) => {
		const next = tail.then(job);
		tail = next.catch(() => undefined);
		return next;
	};
}
