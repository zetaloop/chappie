import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { Source } from "./activity.ts";
import {
	contentWithImageReferences,
	resourceDescriptors,
} from "./resources.ts";

export interface DeliveryRecord extends Source {
	id: string;
	sessionId: string;
	cwd: string;
	toolResults: ToolResultMessage[];
	error?: string;
}

export function toolResultsContent(
	toolResults: ToolResultMessage[],
	sessionId: string,
) {
	return toolResults.flatMap((result) => [
		{
			type: "text" as const,
			text: JSON.stringify({
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				isError: result.isError,
			}),
		},
		...contentWithImageReferences(sessionId, result.content),
		...resourceDescriptors(result.details).map((resource) => ({
			type: "resource_link" as const,
			uri: resource.uri,
			name: resource.name,
			mimeType: resource.mimeType,
			size: resource.size,
		})),
	]);
}

export function deliveryContent(deliveries: DeliveryRecord[]) {
	return deliveries.flatMap((delivery) => [
		{
			type: "text" as const,
			text: JSON.stringify({
				deferredResult: delivery.id,
				requestId: delivery.requestId,
				sessionId: delivery.sessionId,
				cwd: delivery.cwd,
				error: delivery.error,
			}),
		},
		...toolResultsContent(delivery.toolResults, delivery.sessionId),
	]);
}
