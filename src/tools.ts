import * as z from "zod";
import type { Initialization } from "./broker.ts";
import { toolResultsContent } from "./delivery.ts";
import type { ToolResultMessage } from "./host.ts";
import type { SessionInput } from "./ipc.ts";
import { contentWithImageReferences } from "./resources.ts";

export const callsInput = z
	.array(
		z.object({
			name: z.string().min(1),
			arguments: z.record(z.string(), z.unknown()),
		}),
	)
	.min(1);

export type ToolInput = z.infer<typeof callsInput>[number];

export const callInput = z
	.object({
		calls: callsInput.optional(),
		base64: z
			.string()
			.optional()
			.describe(
				"Base64 of the calls array serialized as UTF-8 JSON; supply either calls or base64",
			),
	})
	.refine(
		(input) => (input.calls !== undefined) !== (input.base64 !== undefined),
		"Supply either calls or base64",
	);

export function parseCalls(input: z.infer<typeof callInput>): ToolInput[] {
	if (input.calls) return input.calls;
	const bytes = Buffer.from(atob(input.base64 ?? ""), "latin1");
	return callsInput.parse(
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
	);
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
			text: JSON.stringify({ input: id, sessionId }),
		},
		...(typeof message.content === "string"
			? [{ type: "text" as const, text: message.content }]
			: contentWithImageReferences(sessionId, message.content)),
	]);
}
