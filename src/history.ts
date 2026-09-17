import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as z from "zod";
import { toolResultsContent } from "./delivery.ts";
import { contentWithImageReferences, rememberImages } from "./resources.ts";

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
});

export type HistoryRange = z.infer<typeof historyInput>;
export type HistoryResult = ReturnType<typeof historyResult>;

export const historyInstructions =
	"When resuming work, read recent history to recover progress, then continue from the current request.";

export function historyResult(
	branch: SessionEntry[],
	sessionId: string,
	{ limit, before, after }: HistoryRange,
) {
	const start = after ? entryIndex(branch, after) + 1 : 0;
	const end = before ? entryIndex(branch, before) : branch.length;
	if (start > end) throw new Error("History after must precede before");
	const entries = branch.slice(start, end).filter((entry) => {
		switch (entry.type) {
			case "message":
				return (
					entry.message.role !== "custom" ||
					entry.message.customType !== "chappie.request"
				);
			case "custom_message":
				return entry.customType !== "chappie.request";
			case "custom":
				return entry.customType === "chappie.notice";
			case "compaction":
			case "branch_summary":
				return true;
			default:
				return false;
		}
	});
	const selected = after ? entries.slice(0, limit) : entries.slice(-limit);
	return {
		count: selected.length,
		hasMore: entries.length > selected.length,
		content: selected.flatMap((entry) => entryContent(entry, sessionId)),
	};
}

function entryIndex(entries: SessionEntry[], id: string): number {
	const index = entries.findIndex((entry) => entry.id === id);
	if (index === -1)
		throw new Error(`History entry ${id} is not on the current branch`);
	return index;
}

function entryContent(
	entry: SessionEntry,
	sessionId: string,
): ReturnType<typeof toolResultsContent> {
	const record: Record<string, unknown> = { ...entry };
	const message = entry.type === "message" ? entry.message : entry;
	if (!("content" in message)) {
		return [{ type: "text", text: JSON.stringify(record) }];
	}
	const { content, ...metadata } = message;
	if (entry.type === "message") record.message = metadata;
	else delete record.content;
	const header = { type: "text" as const, text: JSON.stringify(record) };
	if (entry.type === "message" && entry.message.role === "toolResult") {
		rememberImages(sessionId, entry.message.content);
		return [header, ...toolResultsContent([entry.message], sessionId)];
	}
	const blocks =
		typeof content === "string"
			? [{ type: "text" as const, text: content }]
			: content;
	return [
		header,
		...blocks.flatMap((block): ReturnType<typeof toolResultsContent> => {
			if (block.type === "text" || block.type === "image") {
				rememberImages(sessionId, [block]);
				return contentWithImageReferences(sessionId, [block]);
			}
			return [{ type: "text", text: JSON.stringify(block) }];
		}),
	];
}
