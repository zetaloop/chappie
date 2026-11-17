import { readFileSync } from "node:fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod";
import packageJson from "../package.json" with { type: "json" };
import type { Broker } from "./broker.ts";
import { deliveryContent } from "./delivery.ts";
import { transferDescription, transferInput } from "./files.ts";
import { launchDescription, launchInput } from "./launch.ts";
import {
	callInput,
	callsInput,
	chatInput,
	inputContent,
	parseCalls,
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
			"Tool output and session updates. Images and file resources accompany the text as content blocks.",
		),
});

// These hints reduce intermittent tool loss in ChatGPT developer mode.
const toolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

interface RequestContext {
	chatId: string;
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

	function handle<Args, Result>(
		callback: (args: Args, context: RequestContext) => Promise<Result>,
	) {
		return (
			args: Args,
			context: Omit<RequestContext, "chatId">,
		): Promise<Result> => {
			const chatId = requireChatId(context);
			context.mcpReq.signal.throwIfAborted();
			return callback(args, { chatId, mcpReq: context.mcpReq });
		};
	}

	server.registerTool(
		"init",
		{
			title: "Connect to a session",
			description:
				"Select the default session for this conversation and return its environment and tool catalog.",
			outputSchema,
			inputSchema: z.object({
				sessionId: z
					.string()
					.optional()
					.describe("Session to select; omit to reuse the current default"),
			}),
			annotations: toolAnnotations,
		},
		handle(async (args, context) => {
			const { inputs, ...initialized } = await broker.initialize(
				context.chatId,
				args.sessionId,
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
			);
			return finishResult(broker, context, textResult(initialized, inputs));
		}),
	);

	server.registerTool(
		"chat",
		{
			title: "Reply in the session",
			description:
				"Send a Markdown assistant message, or reply to a model request using its request ID as replyTo.",
			outputSchema,
			inputSchema: chatInput.extend({
				sessionId: z
					.string()
					.optional()
					.describe(
						"Session for this operation; defaults to this chat's session",
					),
			}),
			annotations: toolAnnotations,
		},
		handle(async (args, context) => {
			const result = await broker.chat(
				context.chatId,
				args.sessionId,
				args.text,
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
				args.replyTo,
			);
			return finishResult(broker, context, toolResult(result));
		}),
	);

	server.registerTool(
		"tools",
		{
			title: "Native tools",
			description:
				"Get full definitions of native tools for call. Filter by names, or omit names to list all active tools.",
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
					.describe(
						"Session for this operation; defaults to this chat's session",
					),
			}),
			annotations: toolAnnotations,
		},
		handle(async (args, context) => {
			const { inputs, ...inspected } = await broker.tools(
				context.chatId,
				args.sessionId,
				args.names,
				context.mcpReq.signal,
			);
			return finishResult(
				broker,
				context,
				textResult(
					{
						session: inspected.session,
						tools: inspected.tools,
					},
					inputs,
				),
			);
		}),
	);

	server.registerTool(
		"call",
		{
			title: "Run native tools",
			description:
				"Run one native tool batch using the definitions returned by tools.",
			outputSchema,
			inputSchema: callInput.safeExtend({
				sessionId: z
					.string()
					.optional()
					.describe(
						"Session for this operation; defaults to this chat's session",
					),
			}),
			annotations: toolAnnotations,
		},
		handle(async (args, context) => {
			const result = await broker.call(
				context.chatId,
				args.sessionId,
				parseCalls(args),
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
			);
			return finishResult(broker, context, toolResult(result));
		}),
	);

	server.registerTool(
		"transfer",
		{
			title: "Transfer files",
			description: `${transferDescription} Omit files, from, and to to return files to this conversation.`,
			outputSchema,
			inputSchema: transferInput.extend({
				sessionId: z
					.string()
					.optional()
					.describe(
						"Session for this operation; defaults to this chat's session",
					),
			}),
			annotations: toolAnnotations,
			_meta: { "openai/fileParams": ["files"] },
		},
		handle(async ({ sessionId, ...input }, context) => {
			const result = await broker.call(
				context.chatId,
				sessionId,
				callsInput.parse([{ name: "transfer", arguments: input }]),
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
			);
			return finishResult(broker, context, toolResult(result));
		}),
	);

	server.registerTool(
		"history",
		{
			title: "Session history",
			description:
				"Read native conversation records to identify a session's project and task before selecting it.",
			outputSchema,
			inputSchema: z.object({
				sessionId: z
					.string()
					.optional()
					.describe("Session to read; defaults to this chat's session"),
			}),
			annotations: toolAnnotations,
		},
		handle(async (args, context) => {
			const { history, ...session } = await broker.history(
				context.chatId,
				args.sessionId,
				context.mcpReq.signal,
			);
			return formatResult({
				content: [
					...textResult(session).content,
					{ type: "text", text: history },
				],
			});
		}),
	);

	server.registerTool(
		"launch",
		{
			title: "Launch session",
			description: launchDescription,
			outputSchema,
			inputSchema: launchInput,
			annotations: toolAnnotations,
		},
		handle(async (args, context) =>
			finishResult(
				broker,
				context,
				textResult(await broker.launch(args, context.mcpReq.signal)),
			),
		),
	);

	server.registerTool(
		"sessions",
		{
			title: "Sessions",
			description:
				"List online Chappie devices and sessions, and this conversation's default target.",
			outputSchema,
			inputSchema: z.object({
				sessionId: z
					.string()
					.optional()
					.describe("Filter the online list to this session"),
			}),
			annotations: toolAnnotations,
		},
		handle(async (args, context) => {
			const { chatId } = context;
			const inputs = await broker.inputs(
				chatId,
				args.sessionId,
				context.mcpReq.signal,
			);
			const result = textResult(
				{
					binding: broker.binding(chatId) ?? null,
					sessions: broker.listSessions(args.sessionId),
					devices: broker.listDevices(),
				},
				inputs,
			);
			return finishResult(broker, context, result);
		}),
	);

	server.registerResource(
		"Session resource",
		new ResourceTemplate("chappie://session/{sessionId}/{kind}/{id}/{name}", {
			list: undefined,
		}),
		{ title: "Session resource" },
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
	context.mcpReq.signal.throwIfAborted();
	const { chatId } = context;
	const deliveries = broker.deliveries(chatId);
	const content = [...result.content, ...deliveryContent(deliveries)];
	await broker.acknowledge(deliveries, context.mcpReq.signal);
	return formatResult({ ...result, content });
}

function formatResult<
	T extends { content: ReturnType<typeof toolResult>["content"] },
>(result: T) {
	return {
		...result,
		structuredContent: {
			text: result.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("\n"),
		},
	};
}

function requireChatId(context: Pick<RequestContext, "mcpReq">): string {
	const chatId = context.mcpReq._meta?.["openai/session"];
	if (typeof chatId !== "string" || !chatId)
		throw new Error("ChatGPT did not provide openai/session metadata");
	return chatId;
}
