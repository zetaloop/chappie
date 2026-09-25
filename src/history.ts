import * as z from "zod";
import type { Activity, Source } from "./activity.ts";
import type { toolResultsContent } from "./delivery.ts";
import type { AssistantMessage, Content } from "./host.ts";
import {
	contentWithImageReferences,
	rememberImages,
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
	type: string;
	message?: unknown;
	customType?: string;
	data?: unknown;
}

export const historyInstructions =
	"When resuming work, read recent history to recover progress, then continue from the current request.";

export function historyResult(
	branch: readonly HistoryEntry[],
	sessionId: string,
	{ limit, before, after }: HistoryRange,
): HistoryResult {
	const start = after ? entryIndex(branch, after) + 1 : 0;
	const end = before ? entryIndex(branch, before) : branch.length;
	if (start > end) throw new Error("History after must precede before");
	const entries = branch.slice(start, end).filter((entry) => {
		switch (entry.type) {
			case "message": {
				const message = entry.message as { customType?: string };
				return message.customType !== "chappie.request";
			}
			case "custom_message":
				return entry.customType !== "chappie.request";
			case "custom":
				return (
					entry.customType === "chappie.notice" &&
					(entry.data as Activity | undefined)?.event !== "history"
				);
			case "compaction":
			case "branch_summary":
				return true;
			default:
				return false;
		}
	});
	const selected = after ? entries.slice(0, limit) : entries.slice(-limit);
	const sources = new Map<string, Source>();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message as AssistantMessage;
		if (message.role !== "assistant" || !message.chappie) continue;
		for (const block of message.content) {
			if (block.type === "toolCall") sources.set(block.id, message.chappie);
		}
	}
	return {
		count: selected.length,
		hasMore: entries.length > selected.length,
		content: selected.flatMap((entry) =>
			entryContent(entry, sessionId, sources),
		),
	};
}

function entryIndex(entries: readonly HistoryEntry[], id: string): number {
	const index = entries.findIndex((entry) => entry.id === id);
	if (index === -1)
		throw new Error(`History entry ${id} is not on the current branch`);
	return index;
}

function entryContent(
	entry: HistoryEntry,
	sessionId: string,
	sources: Map<string, Source>,
): HistoryResult["content"] {
	const record: Record<string, unknown> = { ...entry };
	const message = (entry.type === "message" ? entry.message : entry) as Record<
		string,
		unknown
	>;
	if (!("content" in message))
		return [{ type: "text", text: JSON.stringify(record) }];
	const { content, ...metadata } = message;
	if (entry.type === "message") {
		const source =
			message.role === "toolResult" && typeof message.toolCallId === "string"
				? sources.get(message.toolCallId)
				: undefined;
		record.message = { ...metadata, ...(source ? { chappie: source } : {}) };
	} else delete record.content;
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
			rememberImages(sessionId, [block]);
			result.push(...contentWithImageReferences(sessionId, [block]));
		} else {
			result.push({ type: "text", text: JSON.stringify(value) });
		}
	}
	for (const resource of resourceDescriptors(message.details))
		result.push({ type: "resource_link", ...resource });
	return result;
}
