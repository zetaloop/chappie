import type { Initialization } from "./broker.ts";
import { toolResultsContent } from "./delivery.ts";
import type { ToolResultMessage } from "./host.ts";
import type { SessionInput } from "./ipc.ts";
import { contentWithImageReferences } from "./resources.ts";

export interface ToolInput {
	name: string;
	arguments: Record<string, unknown>;
}

export function toolResult(
	toolResults: ToolResultMessage[],
	sessionId: string,
	cwd: string,
	inputs: SessionInput[] = [],
	initialization?: Initialization,
) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({
					sessionId,
					cwd,
					...(initialization ? { initialization } : {}),
				}),
			},
			...toolResultsContent(toolResults, sessionId),
			...inputContent(inputs),
		],
		isError: toolResults.some((result) => result.isError),
	};
}

export function inputContent(inputs: SessionInput[]) {
	return inputs.flatMap(({ id, sessionId, message }) => [
		{
			type: "text" as const,
			text: JSON.stringify({ piInput: id, sessionId }),
		},
		...(typeof message.content === "string"
			? [{ type: "text" as const, text: message.content }]
			: contentWithImageReferences(sessionId, message.content)),
	]);
}
