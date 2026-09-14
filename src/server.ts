import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import packageJson from "../package.json" with { type: "json" };
import type { Broker } from "./broker.ts";
import {
	directTools,
	inputContent,
	type ToolInput,
	toolResult,
} from "./tools.ts";

const instructions = readFileSync(
	new URL("./instructions.md", import.meta.url),
	"utf8",
).trim();

interface RequestContext {
	mcpReq: {
		_meta?: Record<string, unknown>;
		signal: AbortSignal;
	};
}

export function createServer(broker: Broker): McpServer {
	const server = new McpServer(
		{
			name: "chappi",
			version: packageJson.version,
		},
		{ instructions },
	);

	server.registerTool(
		"init",
		{
			title: "Connect to Pi",
			description: "Connect this ChatGPT conversation to a Pi session.",
			inputSchema: z.object({
				sessionId: z
					.string()
					.optional()
					.describe("Pi session to select explicitly"),
			}),
			annotations: {
				openWorldHint: false,
			},
		},
		async (args, context) => {
			const chatId = requireChatId(context);
			const { inputs, ...initialized } = await broker.initialize(
				chatId,
				args.sessionId,
				context.mcpReq.signal,
			);
			return textResult(initialized, inputs);
		},
	);

	server.registerTool(
		"chat",
		{
			title: "Reply in Pi",
			description: "Send one complete assistant message to a Pi session.",
			inputSchema: z.object({
				text: z.string().min(1).describe("Assistant message to display in Pi"),
				sessionId: z
					.string()
					.optional()
					.describe("Pi session for this operation only"),
			}),
			annotations: {
				openWorldHint: false,
			},
		},
		async (args, context) => {
			const chatId = requireChatId(context);
			const { message, inputs } = await broker.chat(
				chatId,
				args.sessionId,
				args.text,
				context.mcpReq.signal,
			);
			return textResult({ message }, inputs);
		},
	);

	server.registerTool(
		"tools",
		{
			title: "Pi tools",
			description: "List the tools currently active in a Pi session.",
			inputSchema: z.object({
				sessionId: z
					.string()
					.optional()
					.describe("Pi session for this operation only"),
			}),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (args, context) => {
			const { inputs, ...inspected } = await broker.tools(
				requireChatId(context),
				args.sessionId,
				context.mcpReq.signal,
			);
			return textResult(
				{ session: inspected.session, tools: inspected.tools },
				inputs,
			);
		},
	);

	server.registerTool(
		"call",
		{
			title: "Call Pi tools",
			description: "Execute one or more tools as a native Pi tool batch.",
			inputSchema: z.object({
				calls: z
					.array(
						z.object({
							name: z.string(),
							arguments: z.record(z.string(), z.unknown()),
						}),
					)
					.min(1),
				sessionId: z
					.string()
					.optional()
					.describe("Pi session for this operation only"),
			}),
			annotations: {
				openWorldHint: true,
			},
		},
		async (args, context) => {
			const result = await broker.call(
				requireChatId(context),
				args.sessionId,
				args.calls,
				context.mcpReq.signal,
			);
			return toolResult(result.toolResults, result.inputs);
		},
	);

	for (const tool of directTools) {
		server.registerTool(
			tool.name,
			{
				title: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: {
					readOnlyHint: tool.name === "read",
					idempotentHint: tool.name === "read",
					openWorldHint: tool.name === "bash",
				},
			},
			async (args, context) => {
				const input = { ...args } as Record<string, unknown> & {
					sessionId?: string;
				};
				const sessionId = input.sessionId;
				delete input.sessionId;
				const calls: ToolInput[] = [{ name: tool.name, arguments: input }];
				const result = await broker.call(
					requireChatId(context),
					sessionId,
					calls,
					context.mcpReq.signal,
				);
				return toolResult(result.toolResults, result.inputs);
			},
		);
	}

	server.registerTool(
		"sessions",
		{
			title: "Local sessions",
			description:
				"List connected Pi sessions and the current conversation binding.",
			inputSchema: z.object({
				sessionId: z
					.string()
					.optional()
					.describe("Return only this Pi session when it is online"),
			}),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (args, context) => {
			const chatId = requestChatId(context);
			const inputs = chatId
				? await broker.inputs(chatId, args.sessionId, context.mcpReq.signal)
				: [];
			return textResult(
				{
					binding: chatId ? (broker.binding(chatId) ?? null) : null,
					sessions: broker.listSessions(args.sessionId),
				},
				inputs,
			);
		},
	);

	return server;
}

function textResult(
	value: unknown,
	inputs: Parameters<typeof inputContent>[0] = [],
) {
	return {
		content: [
			{ type: "text" as const, text: JSON.stringify(value) },
			...inputContent(inputs),
		],
	};
}

function requestChatId(context: RequestContext): string | undefined {
	const value = context.mcpReq._meta?.["openai/session"];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireChatId(context: RequestContext): string {
	const chatId = requestChatId(context);
	if (!chatId)
		throw new Error("ChatGPT did not provide openai/session metadata");
	return chatId;
}
