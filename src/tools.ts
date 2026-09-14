import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import type { SessionInput } from "./ipc.ts";

export interface ToolInput {
	name: string;
	arguments: Record<string, unknown>;
}

const definitions = [
	createReadToolDefinition("."),
	createBashToolDefinition("."),
	createEditToolDefinition("."),
	createWriteToolDefinition("."),
];

export const directTools = definitions.map((definition) => ({
	name: definition.name,
	description: definition.description,
	inputSchema: fromJsonSchema<Record<string, unknown>>(
		withSessionId(definition.parameters as unknown as Record<string, unknown>),
	),
}));

export function toolResult(
	toolResults: ToolResultMessage[],
	inputs: SessionInput[] = [],
) {
	return {
		content: [
			...toolResults.flatMap((result) => [
				{
					type: "text" as const,
					text: JSON.stringify({
						toolCallId: result.toolCallId,
						toolName: result.toolName,
						isError: result.isError,
					}),
				},
				...result.content,
			]),
			...inputContent(inputs),
		],
		isError: toolResults.some((result) => result.isError),
	};
}

export function inputContent(inputs: SessionInput[]) {
	return inputs.flatMap(({ id, message }) => [
		{
			type: "text" as const,
			text: JSON.stringify({ piInput: id }),
		},
		...(typeof message.content === "string"
			? [{ type: "text" as const, text: message.content }]
			: message.content),
	]);
}

function withSessionId(
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const copy = structuredClone(schema) as {
		properties?: Record<string, unknown>;
	};
	return {
		...copy,
		properties: {
			...copy.properties,
			sessionId: {
				type: "string",
				description: "Pi session for this operation only",
			},
		},
		additionalProperties: false,
	};
}
