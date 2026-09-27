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
}

export interface NativeTool {
	name: string;
	description: string;
	parameters: z.ZodObject;
	execute(
		args: unknown,
		signal?: AbortSignal,
		update?: (result: NativeResult) => void,
	): Promise<NativeResult>;
}

export const definitions = [
	tool(
		"sessions",
		"List connected Chappie sessions and identify this local session.",
		z.object({
			sessionId: z.string().optional(),
		}),
		async (session, { sessionId }, signal) =>
			textResult(await session.sessions(sessionId, signal)),
	),
	tool(
		"remote_tools",
		"Read native tool definitions from a Chappie session.",
		z.object({
			sessionId: z.string().min(1),
			names: z.array(z.string()).min(1).optional(),
		}),
		async (session, { sessionId, names }, signal) =>
			textResult(await session.tools(sessionId, names, signal)),
	),
	tool(
		"remote_call",
		"Execute one native tool batch in a Chappie session using definitions from remote_tools.",
		z.object({
			sessionId: z.string().min(1),
			calls: callsInput,
		}),
		async (session, { sessionId, calls }, signal) => {
			const result = await session.call(sessionId, calls, signal);
			const output = toolResult(
				result.toolResults,
				sessionId,
				result.cwd,
				result.inputs,
			);
			const content = nativeContent(output.content);
			if (output.isError) {
				throw new Error(
					[...content, ...localDeliveries(session)]
						.flatMap((block) => (block.type === "text" ? [block.text] : []))
						.join("\n"),
				);
			}
			return {
				content,
				details: {
					resources: result.toolResults.flatMap((result) =>
						resourceDescriptors(result.details),
					),
				},
			};
		},
	),
	tool(
		"history",
		"Read this session's history, or a Chappie session identified by sessionId. Use before/after to page and wait to follow remote progress.",
		historyInput.extend({
			sessionId: z.string().optional(),
		}),
		async (session, { sessionId, ...range }, signal) => {
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
		(session, args, signal, update) =>
			session.transfer(args, signal, (details) =>
				update?.({ content: [], details }),
			),
	),
];

export function localTools(session: Session): NativeTool[] {
	return definitions.map((tool) => ({
		...tool,
		async execute(
			args: unknown,
			signal?: AbortSignal,
			update?: (result: NativeResult) => void,
		) {
			const result = await tool.execute(session, args, signal, update);
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

function tool<S extends z.ZodObject>(
	name: string,
	description: string,
	parameters: S,
	execute: (
		session: Session,
		args: z.output<S>,
		signal?: AbortSignal,
		update?: (result: NativeResult) => void,
	) => Promise<NativeResult>,
) {
	return {
		name,
		description,
		parameters,
		execute: (
			session: Session,
			args: unknown,
			signal?: AbortSignal,
			update?: (result: NativeResult) => void,
		) => execute(session, parameters.parse(args), signal, update),
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
