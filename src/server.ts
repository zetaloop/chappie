import { readFileSync } from "node:fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod";
import packageJson from "../package.json" with { type: "json" };
import type { Broker } from "./broker.ts";
import { deliveryContent } from "./delivery.ts";
import {
	answerContent,
	answerInput,
	questionInput,
	questionOutput,
} from "./questions.ts";
import {
	directTools,
	inputContent,
	type ToolInput,
	toolResult,
} from "./tools.ts";

const instructions = readFileSync(
	new URL("./instructions.md", import.meta.url),
	"utf8",
)
	.trim()
	.split("\n\n");

const outputSchema = z.object({
	text: z
		.string()
		.describe(
			"Complete text output, including Pi user input, submitted webpage answers, and deferred results. Images and file resources accompany it as native content blocks.",
		),
});

const questionTemplate = "ui://chappie/question.html";
const questionSchema = outputSchema.extend({ question: questionOutput });

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
		{
			instructions: instructions
				.filter(
					(paragraph) => broker.askEnabled || !paragraph.startsWith("Use ask "),
				)
				.join("\n\n"),
		},
	);

	function handle<Args, Result>(
		callback: (args: Args, context: RequestContext) => Promise<Result>,
	) {
		return async (args: Args, context: RequestContext): Promise<Result> => {
			const signal = await broker.workflow(
				requestChatId(context),
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
			);
			return callback(args, {
				...context,
				mcpReq: { ...context.mcpReq, signal },
			});
		};
	}

	server.registerTool(
		"init",
		{
			title: "Connect to Pi",
			description:
				"Select this chat's default Pi session and return its environment and tool catalog. Use the task's sessionId to resume, or find it by cwd/name with sessions. For a task without a specified target, omit sessionId to reuse the default or select the first online, unbound session.",
			outputSchema,
			inputSchema: z.object({
				sessionId: z
					.string()
					.optional()
					.describe("Default Pi session ID; may be shared with other chats"),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				openWorldHint: false,
			},
		},
		handle(async (args, context) => {
			const chatId = requireChatId(context);
			const { inputs, ...initialized } = await broker.initialize(
				chatId,
				args.sessionId,
				context.mcpReq.signal,
			);
			return finishResult(broker, context, textResult(initialized, inputs));
		}),
	);

	server.registerTool(
		"chat",
		{
			title: "Reply in Pi",
			description:
				"Send an assistant message to Pi. Renders Markdown and saves the message in the session transcript.",
			outputSchema,
			inputSchema: z.object({
				text: z.string().min(1).describe("Assistant message in Markdown"),
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
		handle(async (args, context) => {
			const chatId = requireChatId(context);
			const { sessionId, cwd, inputs } = await broker.chat(
				chatId,
				args.sessionId,
				args.text,
				context.mcpReq.signal,
			);
			return finishResult(
				broker,
				context,
				textResult({ sessionId, cwd }, inputs),
			);
		}),
	);

	const askTool = server.registerTool(
		"ask",
		{
			title: "Ask in ChatGPT",
			description:
				"Create a question in ChatGPT and return its ID immediately. Call ask_assert next with question.id. Answers, revisions, and skips arrive as webAnswer in later tool results.",
			inputSchema: questionInput.extend({
				sessionId: z
					.string()
					.optional()
					.describe(
						"Pi session for this question; defaults to this chat's session",
					),
			}),
			outputSchema: questionSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				openWorldHint: false,
			},
			_meta: { ui: { resourceUri: questionTemplate } },
		},
		handle(async ({ sessionId, ...input }, context) => {
			const question = await broker.ask(
				requireChatId(context),
				sessionId,
				input,
				context.mcpReq.signal,
			);
			const result = await finishResult(broker, context, {
				content: [
					{
						type: "text",
						text: `Question created. Call ask_assert({"questionId":"${question.id}"}) next.`,
					},
				],
			});
			return {
				...result,
				structuredContent: { ...result.structuredContent, question },
			};
		}),
	);

	const askAssertTool = server.registerTool(
		"ask_assert",
		{
			title: "Assert question display",
			description:
				"Assert that an ask widget loaded in ChatGPT. Call immediately after ask with question.id. Returns when the widget reports loaded; times out if it fails to load. User answers arrive separately as webAnswer.",
			inputSchema: z.object({
				questionId: z.string().describe("question.id returned by ask"),
			}),
			outputSchema: questionSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		handle(async ({ questionId }, context) => {
			const question = await broker.assertQuestion(
				requireChatId(context),
				questionId,
				context.mcpReq.signal,
			);
			const result = await finishResult(broker, context, {
				content: [{ type: "text", text: "Question widget loaded." }],
			});
			return {
				...result,
				structuredContent: { ...result.structuredContent, question },
			};
		}),
	);

	const answerTool = server.registerTool(
		"answer",
		{
			title: "Question state",
			description:
				"Read a saved question, report widget loading, or save an answer, revision, or skip.",
			inputSchema: z.object({
				questionId: z.string(),
				answer: answerInput.optional(),
				loaded: z
					.literal(true)
					.optional()
					.describe("The question widget has loaded"),
			}),
			outputSchema: questionSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			_meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
		},
		handle(async ({ questionId, answer, loaded = false }, context) => {
			const question = await broker.answer(
				requireChatId(context),
				questionId,
				answer,
				loaded,
			);
			const text = answer
				? answer.skipped
					? "Question skipped."
					: "Answer saved."
				: loaded
					? "Question widget loaded."
					: "Question state.";
			return {
				content: [{ type: "text", text }],
				structuredContent: { text, question },
			};
		}),
	);

	const questionResource = server.registerResource(
		"question",
		questionTemplate,
		{ title: "Chappie question", mimeType: "text/html;profile=mcp-app" },
		async () => ({
			contents: [
				{
					uri: questionTemplate,
					mimeType: "text/html;profile=mcp-app",
					text: readFileSync(
						new URL("./question.html", import.meta.url),
						"utf8",
					),
					_meta: {
						ui: {
							prefersBorder: true,
							csp: { connectDomains: [], resourceDomains: [] },
						},
						"openai/widgetDescription":
							"A persistent question the user can answer while the assistant continues working.",
					},
				},
			],
		}),
	);

	if (!broker.askEnabled) {
		askTool.remove();
		askAssertTool.remove();
		answerTool.remove();
		questionResource.remove();
	}

	server.registerTool(
		"tools",
		{
			title: "Pi tools",
			description:
				"Get full definitions of Pi tools for call. Filter by names, or omit names to list all active tools.",
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
		handle(async (args, context) => {
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
		}),
	);

	server.registerTool(
		"call",
		{
			title: "Call Pi tools",
			description:
				"Execute Pi tools using the definitions returned by tools. Each calls array is one native Pi batch.",
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
		handle(async (args, context) => {
			const result = await broker.call(
				requireChatId(context),
				args.sessionId,
				args.calls,
				context.mcpReq.signal,
			);
			return finishResult(
				broker,
				context,
				toolResult(
					result.toolResults,
					result.sessionId,
					result.cwd,
					result.inputs,
				),
			);
		}),
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
			handle(async (args, context) => {
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
					toolResult(
						result.toolResults,
						result.sessionId,
						result.cwd,
						result.inputs,
					),
				);
			}),
		);
	}

	server.registerTool(
		"sessions",
		{
			title: "Local sessions",
			description:
				"List online Pi sessions with their IDs, cwd, names, execution status, and saved binding counts. Also returns this chat's default.",
			outputSchema,
			inputSchema: z.object({
				sessionId: z
					.string()
					.optional()
					.describe("Filter the online list to this Pi session"),
			}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		handle(async (args, context) => {
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
		}),
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
	const answers = chatId ? broker.answers(chatId) : [];
	const content = [
		...result.content,
		...deliveryContent(deliveries),
		...answerContent(answers),
	];
	const structuredContent = {
		text: content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n"),
	};
	await broker.acknowledge(deliveries, answers, context.mcpReq.signal);
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
