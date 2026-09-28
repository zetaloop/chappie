import * as z from "zod";
import type { CallResult, ChatResult } from "./broker.ts";
import { toolResultsContent } from "./delivery.ts";
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

export const chatInput = z.object({
	text: z
		.string()
		.min(1)
		.describe("Assistant message or requested model output"),
	replyTo: z.string().optional().describe("Model request ID to answer"),
});

export function parseCalls(input: z.infer<typeof callInput>): ToolInput[] {
	if (input.calls) return input.calls;
	const bytes = Buffer.from(atob(input.base64 ?? ""), "latin1");
	return callsInput.parse(
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
	);
}

export function toolResult(
	result: ChatResult | CallResult,
	replyTool: "chat" | "remote_chat" = "chat",
) {
	const { sessionId, cwd, inputs, initialization, cancelled } = result;
	const toolResults = "toolResults" in result ? result.toolResults : [];
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
			...inputContent(inputs, replyTool),
		],
		isError: Boolean(cancelled) || toolResults.some((result) => result.isError),
	};
}

export function inputContent(
	inputs: SessionInput[],
	replyTool: "chat" | "remote_chat" = "chat",
) {
	const callTool = replyTool === "chat" ? "call" : "remote_call";
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
						instructions: `This session is requesting ${task}. Follow the input below and reply with ${replyTool} using this sessionId and the request ID as replyTo. Use history if needed; ${callTool} cannot execute tools in this session until this request finishes.`,
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
