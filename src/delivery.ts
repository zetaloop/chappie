import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	contentWithImageReferences,
	resourceDescriptors,
} from "./resources.ts";

export interface DeliveryRecord {
	id: string;
	chatId: string;
	sessionId: string;
	cwd: string;
	toolResults: ToolResultMessage[];
	error?: string;
}

export function deliveryContent(deliveries: DeliveryRecord[]) {
	return deliveries.flatMap((delivery) => [
		{
			type: "text" as const,
			text: JSON.stringify({
				deferredResult: delivery.id,
				sessionId: delivery.sessionId,
				cwd: delivery.cwd,
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
