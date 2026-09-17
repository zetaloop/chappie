import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { toolResultsContent } from "./delivery.ts";
import type { SessionInput } from "./ipc.ts";
import { contentWithImageReferences } from "./resources.ts";
import { transfer } from "./transfer.ts";

export interface ToolInput {
	name: string;
	arguments: Record<string, unknown>;
}

const definitions = [
	createReadToolDefinition("."),
	createBashToolDefinition("."),
	createEditToolDefinition("."),
	createWriteToolDefinition("."),
	transfer,
];

export const directTools = definitions.map((definition) => ({
	name: definition.name,
	description: definition.description,
	inputSchema: fromJsonSchema<Record<string, unknown>>(
		withSessionId(definition.parameters as unknown as Record<string, unknown>),
	),
	fileParams: definition.name === "transfer" ? ["files"] : undefined,
}));

export function toolResult(
	toolResults: ToolResultMessage[],
	sessionId: string,
	cwd: string,
	inputs: SessionInput[] = [],
) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify({ sessionId, cwd }) },
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
