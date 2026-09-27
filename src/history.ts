import * as z from "zod";
import type { toolResultsContent } from "./delivery.ts";
import type { Content } from "./host.ts";
import {
	contentWithImageReferences,
	type ResourceDescriptor,
	resourceDescriptors,
} from "./resources.ts";

export const historyInput = z.object({
	limit: z
		.number()
		.int()
		.min(1)
		.default(20)
		.describe("Maximum number of history entries"),
	before: z
		.string()
		.min(1)
		.optional()
		.describe("Read entries before this entry ID"),
	after: z
		.string()
		.min(1)
		.optional()
		.describe("Read entries after this entry ID, starting with the earliest"),
	wait: z
		.boolean()
		.optional()
		.describe(
			"Wait up to 30 seconds for new entries when caught up; before reads return immediately",
		),
	observer: z
		.boolean()
		.optional()
		.describe("Read work progress as an observer"),
});

export type HistoryRange = z.infer<typeof historyInput>;

export interface HistoryResult {
	count: number;
	hasMore: boolean;
	content: ReturnType<typeof toolResultsContent>;
}

export interface HistoryEntry {
	id: string;
	timestamp?: string;
	content?: unknown;
	[key: string]: unknown;
}

export const historyInstructions =
	"When resuming work, read recent history to recover progress, then continue from the current request.";

export function historyPage<T extends { id: string }>(
	branch: readonly T[],
	{ limit, before, after }: HistoryRange,
	visible: (entry: T) => boolean = () => true,
): { entries: T[]; hasMore: boolean } {
	const start = after ? entryIndex(branch, after) + 1 : 0;
	const end = before ? entryIndex(branch, before) : branch.length;
	if (start > end) throw new Error("History after must precede before");
	const entries = branch.slice(start, end).filter(visible);
	return {
		entries: after ? entries.slice(0, limit) : entries.slice(-limit),
		hasMore: entries.length > limit,
	};
}

export function historyResult(
	{ entries, hasMore }: { entries: readonly HistoryEntry[]; hasMore: boolean },
	sessionId: string,
): HistoryResult {
	return {
		count: entries.length,
		hasMore,
		content: entries.flatMap((entry) => entryContent(entry, sessionId)),
	};
}

function entryIndex(entries: readonly { id: string }[], id: string): number {
	const index = entries.findIndex((entry) => entry.id === id);
	if (index === -1)
		throw new Error(`History entry ${id} is not on the current branch`);
	return index;
}

function entryContent(
	entry: HistoryEntry,
	sessionId: string,
): HistoryResult["content"] {
	const { content, ...record } = entry;
	const result: HistoryResult["content"] = [
		{ type: "text", text: JSON.stringify(record) },
	];
	const blocks: unknown[] =
		typeof content === "string"
			? [{ type: "text", text: content }]
			: Array.isArray(content)
				? content
				: [];
	for (const value of blocks) {
		if (
			value &&
			typeof value === "object" &&
			"type" in value &&
			(value.type === "text" || value.type === "image")
		) {
			const block = value as Content;
			result.push(...contentWithImageReferences(sessionId, [block]));
		} else if (
			value &&
			typeof value === "object" &&
			"type" in value &&
			value.type === "resource_link"
		) {
			result.push(value as ResourceDescriptor & { type: "resource_link" });
		} else {
			result.push({ type: "text", text: JSON.stringify(value) });
		}
	}
	for (const resource of resourceDescriptors(entry.details))
		result.push({ type: "resource_link", ...resource });
	return result;
}
