import * as z from "zod";
import { deliveryContent } from "./delivery.ts";
import { transferDescription, transferInput } from "./files.ts";
import { historyInput } from "./history.ts";
import type { Content } from "./host.ts";
import { resourceDescriptors } from "./resources.ts";
import type { Session } from "./session.ts";
import { callsInput, toolResult } from "./tools.ts";

export interface NativeResult {
	content: Content[];
	details?: unknown;
	isError?: boolean;
}

export interface NativeTool {
	name: string;
	description: string;
	parameters: z.ZodType;
	execute(
		args: unknown,
		signal?: AbortSignal,
		update?: (result: NativeResult) => void,
	): Promise<NativeResult>;
}

export function localTools(session: Session): NativeTool[] {
	const tools = [
		tool(
			"sessions",
			"List connected Chappie sessions and identify this local session.",
			z.object({
				sessionId: z.string().optional(),
			}),
			async ({ sessionId }, signal) =>
				textResult(await session.sessions(sessionId, signal)),
		),
		tool(
			"remote_tools",
			"Read native tool definitions from a Chappie session.",
			z.object({
				sessionId: z.string().min(1),
				names: z.array(z.string()).min(1).optional(),
			}),
			async ({ sessionId, names }, signal) =>
				textResult(await session.tools(sessionId, names, signal)),
		),
		tool(
			"remote_call",
			"Execute one native tool batch in a Chappie session using definitions from remote_tools.",
			z.object({
				sessionId: z.string().min(1),
				calls: callsInput,
			}),
			async ({ sessionId, calls }, signal) => {
				const result = await session.call(sessionId, calls, signal);
				return {
					content: nativeContent(
						toolResult(result.toolResults, sessionId, result.cwd, result.inputs)
							.content,
					),
					details: {
						resources: result.toolResults.flatMap((result) =>
							resourceDescriptors(result.details),
						),
					},
					isError: result.toolResults.some((result) => result.isError),
				};
			},
		),
		tool(
			"history",
			"Read this session's history, or a Chappie session identified by sessionId. Use before/after to page and wait to follow remote progress.",
			historyInput.extend({
				sessionId: z.string().optional(),
			}),
			async ({ sessionId, ...range }, signal) => {
				const { content, ...page } = await session.history(
					range,
					sessionId,
					signal,
				);
				return {
					content: [...textResult(page).content, ...nativeContent(content)],
				};
			},
		),
		tool(
			"transfer",
			transferDescription,
			transferInput,
			(args, signal, update) =>
				session.transfer(args, signal, (details) =>
					update?.({ content: [], details }),
				),
		),
	];
	return tools.map((tool) => ({
		...tool,
		async execute(
			args: unknown,
			signal?: AbortSignal,
			update?: (result: NativeResult) => void,
		) {
			const result = await tool.execute(args, signal, update);
			return {
				...result,
				content: [...result.content, ...localDeliveries(session)],
			};
		},
	}));
}

export function localDeliveries(session: Session): Content[] {
	return nativeContent(deliveryContent(session.deliveries()));
}

function tool<S extends z.ZodType>(
	name: string,
	description: string,
	parameters: S,
	execute: (
		args: z.output<S>,
		signal?: AbortSignal,
		update?: (result: NativeResult) => void,
	) => Promise<NativeResult>,
): NativeTool {
	return {
		name,
		description,
		parameters,
		execute: (args, signal, update) =>
			execute(parameters.parse(args), signal, update),
	};
}

function textResult(value: unknown): NativeResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function nativeContent(
	content: ReturnType<typeof toolResult>["content"],
): Content[] {
	return content.map((block) =>
		block.type === "resource_link"
			? { type: "text", text: JSON.stringify({ resource: block }) }
			: block,
	);
}
