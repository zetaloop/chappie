import { readFileSync } from "node:fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod";
import packageJson from "../package.json" with { type: "json" };
import type { Broker } from "./broker.ts";
import { deliveryContent } from "./delivery.ts";
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

const outputSchema = z.object({
	text: z
		.string()
		.describe(
			"Complete text output, including Pi user input and deferred results. Images and file resources accompany it as native content blocks.",
		),
});

interface RequestContext {
	mcpReq: {
		_meta?: Record<string, unknown>;
		signal: AbortSignal;
	};
}

export function createServer(broker: Broker): McpServer {
	const server = new McpServer(
		{
			name: "chappie",
			version: packageJson.version,
		},
		{ instructions },
	);

	server.registerTool(
		"init",
		{
			title: "Connect to Pi",
			description:
				"Connect this ChatGPT conversation to an online Pi session. A sessionId on init becomes the new default.",
			outputSchema,
			inputSchema: z.object({
				sessionId: z
					.string()
					.optional()
					.describe("Pi session to select explicitly"),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
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
			return finishResult(broker, context, textResult(initialized, inputs));
		},
	);

	server.registerTool(
		"chat",
		{
			title: "Reply in Pi",
			description:
				"Display the supplied Markdown in Pi and append it to the session transcript. Code blocks are displayed as text.",
			outputSchema,
			inputSchema: z.object({
				text: z
					.string()
					.min(1)
					.describe("Markdown message, including prose and code examples"),
				sessionId: z
					.string()
					.optional()
					.describe("Pi session for this operation only"),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				openWorldHint: false,
			},
		},
		async (args, context) => {
			const chatId = requireChatId(context);
			const { sessionId, inputs } = await broker.chat(
				chatId,
				args.sessionId,
				args.text,
				context.mcpReq.signal,
			);
			return finishResult(broker, context, textResult({ sessionId }, inputs));
		},
	);

	server.registerTool(
		"tools",
		{
			title: "Pi tools",
			description:
				"Return complete definitions for active Pi tools. Provide names to inspect only those tools.",
			outputSchema,
			inputSchema: z.object({
				names: z
					.array(z.string())
					.min(1)
					.optional()
					.describe("Tool names to describe; omit to return every active tool"),
				sessionId: z
					.string()
					.optional()
					.describe("Pi session for this operation only"),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (args, context) => {
			const { inputs, ...inspected } = await broker.tools(
				requireChatId(context),
				args.sessionId,
				args.names,
				context.mcpReq.signal,
			);
			return finishResult(
				broker,
				context,
				textResult(
					{ session: inspected.session, tools: inspected.tools },
					inputs,
				),
			);
		},
	);

	server.registerTool(
		"call",
		{
			title: "Call Pi tools",
			description:
				"Execute one or more active Pi tools as one native batch. Arguments must match definitions returned by tools.",
			outputSchema,
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
				readOnlyHint: false,
				destructiveHint: true,
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
			return finishResult(
				broker,
				context,
				toolResult(result.toolResults, result.sessionId, result.inputs),
			);
		},
	);

	for (const tool of directTools) {
		server.registerTool(
			tool.name,
			{
				title: tool.name,
				description: tool.description,
				outputSchema,
				inputSchema: tool.inputSchema,
				annotations: {
					readOnlyHint: tool.name === "read",
					destructiveHint: tool.name !== "read",
					idempotentHint: tool.name === "read",
					openWorldHint: tool.name === "bash" || tool.name === "transfer",
				},
				...(tool.fileParams
					? { _meta: { "openai/fileParams": tool.fileParams } }
					: {}),
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
				return finishResult(
					broker,
					context,
					toolResult(result.toolResults, result.sessionId, result.inputs),
				);
			},
		);
	}

	server.registerTool(
		"sessions",
		{
			title: "Local sessions",
			description:
				"List online Pi sessions and the current conversation binding without waiting for offline sessions.",
			outputSchema,
			inputSchema: z.object({
				sessionId: z
					.string()
					.optional()
					.describe("Return this Pi session when it is online"),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (args, context) => {
			const chatId = requestChatId(context);
			const inputs = chatId
				? await broker.inputs(chatId, args.sessionId, context.mcpReq.signal)
				: [];
			const result = textResult(
				{
					binding: chatId ? (broker.binding(chatId) ?? null) : null,
					sessions: broker.listSessions(args.sessionId),
				},
				inputs,
			);
			return finishResult(broker, context, result);
		},
	);

	server.registerResource(
		"Pi resource",
		new ResourceTemplate("chappie://session/{sessionId}/{kind}/{id}/{name}", {
			list: undefined,
		}),
		{ title: "Pi resource" },
		async (uri, _variables, context) => {
			const resource = await broker.readResource(
				uri.href,
				context.mcpReq.signal,
			);
			return {
				contents: [
					{
						uri: resource.uri,
						mimeType: resource.mimeType,
						blob: resource.blob,
					},
				],
			};
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

async function finishResult<
	T extends { content: ReturnType<typeof toolResult>["content"] },
>(broker: Broker, context: RequestContext, result: T) {
	const chatId = requestChatId(context);
	const deliveries = chatId ? await broker.deliveries(chatId) : [];
	const content = [...result.content, ...deliveryContent(deliveries)];
	const structuredContent = {
		text: content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n"),
	};
	await broker.acknowledgeDeliveries(deliveries, context.mcpReq.signal);
	return { ...result, content, structuredContent };
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
