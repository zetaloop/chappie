import type { Activity, Source } from "./activity.ts";
import {
	type HistoryEntry,
	type HistoryRange,
	historyPage,
	historyResult,
} from "./history.ts";
import type { AssistantMessage } from "./host.ts";

interface JournalEntry {
	id: string;
	type: string;
	timestamp?: string;
	message?: unknown;
	customType?: string;
	data?: unknown;
}

export function journalHistory(
	branch: readonly JournalEntry[],
	sessionId: string,
	range: HistoryRange,
) {
	const page = historyPage(branch, range, (entry) => {
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
	const sources = new Map<string, Source>();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message as AssistantMessage;
		if (message.role !== "assistant" || !message.chappie) continue;
		for (const block of message.content) {
			if (block.type === "toolCall") sources.set(block.id, message.chappie);
		}
	}
	return historyResult(
		{
			...page,
			entries: page.entries.map((entry): HistoryEntry => {
				const { message: value, ...record } = entry;
				if (entry.type !== "message") return record;
				const message = value as Record<string, unknown>;
				const source =
					message.role === "toolResult" &&
					typeof message.toolCallId === "string"
						? sources.get(message.toolCallId)
						: undefined;
				return {
					...message,
					...record,
					...(source ? { chappie: source } : {}),
				};
			}),
		},
		sessionId,
	);
}
