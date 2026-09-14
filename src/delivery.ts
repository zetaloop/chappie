import { readFile } from "node:fs/promises";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	contentWithImageReferences,
	resourceDescriptors,
} from "./resources.ts";

export interface DeliveryRecord {
	id: string;
	chatId: string;
	sessionId: string;
	sessionFile?: string;
	toolCallIds: string[];
	inlineResults?: ToolResultMessage[];
	error?: string;
}

export interface ResolvedDelivery extends DeliveryRecord {
	toolResults: ToolResultMessage[];
}

export async function resolveDelivery(
	delivery: DeliveryRecord,
): Promise<ResolvedDelivery> {
	let toolResults = delivery.inlineResults ?? [];
	if (delivery.sessionFile && delivery.toolCallIds.length > 0) {
		const expected = new Set(delivery.toolCallIds);
		const found = new Map<string, ToolResultMessage>();
		for (const line of (await readFile(delivery.sessionFile, "utf8")).split(
			"\n",
		)) {
			if (!line) continue;
			const entry = JSON.parse(line) as {
				type?: string;
				message?: ToolResultMessage;
			};
			if (
				entry.type === "message" &&
				entry.message?.role === "toolResult" &&
				expected.has(entry.message.toolCallId)
			) {
				found.set(entry.message.toolCallId, entry.message);
			}
		}
		toolResults = delivery.toolCallIds.flatMap((id) => {
			const result = found.get(id);
			return result ? [result] : [];
		});
	}
	return { ...delivery, toolResults };
}

export function deliveryContent(deliveries: ResolvedDelivery[]) {
	return deliveries.flatMap((delivery) => [
		{
			type: "text" as const,
			text: JSON.stringify({
				deferredResult: delivery.id,
				sessionId: delivery.sessionId,
				error: delivery.error,
			}),
		},
		...delivery.toolResults.flatMap((result) => [
			{
				type: "text" as const,
				text: JSON.stringify({
					toolCallId: result.toolCallId,
					toolName: result.toolName,
					isError: result.isError,
				}),
			},
			...contentWithImageReferences(delivery.sessionId, result.content),
			...resourceDescriptors(result.details).map((resource) => ({
				type: "resource_link" as const,
				uri: resource.uri,
				name: resource.name,
				mimeType: resource.mimeType,
				size: resource.size,
			})),
		]),
	]);
}
