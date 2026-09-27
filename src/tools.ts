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
			arguments: z.record(z.string(), z.json()),
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
	cancelled?: string,
) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({
					sessionId,
					cwd,
					...(initialization ? { initialization } : {}),
					...(cancelled ? { cancelled } : {}),
				}),
			},
			...toolResultsContent(toolResults, sessionId),
			...inputContent(inputs),
		],
		isError: Boolean(cancelled) || toolResults.some((result) => result.isError),
	};
}

export function inputContent(inputs: SessionInput[]) {
	return inputs.flatMap((input) => {
		const { id, sessionId } = input;
		if ("request" in input) {
			const task =
				input.request.kind === "compaction"
					? "a context summary"
					: `a ${input.request.kind} response`;
			return [
				{
					type: "text" as const,
					text: JSON.stringify({
						request: id,
						sessionId,
						kind: input.request.kind,
						instructions: `This session is requesting ${task}. Follow the input below and reply with chat using this sessionId and the request ID as replyTo. Use history if needed; call cannot execute tools in this session until this request finishes.`,
					}),
				},
				{ type: "text" as const, text: JSON.stringify(input.request.input) },
			];
		}
		return [
			{ type: "text" as const, text: JSON.stringify({ input: id, sessionId }) },
			...(typeof input.message.content === "string"
				? [{ type: "text" as const, text: input.message.content }]
				: contentWithImageReferences(sessionId, input.message.content)),
		];
	});
}
