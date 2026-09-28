import { readFileSync } from "node:fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import * as z from "zod";
import packageJson from "../package.json" with { type: "json" };
import type { Broker } from "./broker.ts";
import { deliveryContent } from "./delivery.ts";
import { transferDescription, transferInput } from "./files.ts";
import { historyInput } from "./history.ts";
import {
	answerContent,
	answerInput,
	questionInput,
	questionInstructions,
	questionOutput,
} from "./questions.ts";
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

const questionTemplate = "ui://chappie/question.html";
const questionSchema = outputSchema.extend({ question: questionOutput });
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
		{
			instructions: [
				instructions,
				...(broker.askEnabled ? [questionInstructions] : []),
			].join("\n\n"),
		},
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
				"Select the default session for this conversation and return its environment, tool catalog, and participation instructions.",
			outputSchema,
			inputSchema: z.object({
				sessionId: z
					.string()
					.optional()
					.describe(
						"Session to select; omit to reuse the default or choose an online unbound session",
					),
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
						"session for this operation; becomes the default if none is set",
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

	if (broker.askEnabled) {
		server.registerTool(
			"ask",
			{
				title: "Ask in ChatGPT",
				description:
					"Ask a question in ChatGPT. Call ask_assert next with question.id to confirm display; answers arrive as webAnswer.",
				inputSchema: questionInput.extend({
					sessionId: z
						.string()
						.optional()
						.describe(
							"session for this question; defaults to this chat's session",
						),
				}),
				outputSchema: questionSchema,
				annotations: toolAnnotations,
				_meta: { ui: { resourceUri: questionTemplate } },
			},
			handle(async ({ sessionId, ...input }, context) => {
				const { initialization, ...question } = await broker.ask(
					context.chatId,
					sessionId,
					input,
					context.mcpReq._meta?.["otunnel/requestId"],
					context.mcpReq.signal,
				);
				const result = await finishResult(broker, context, {
					content: [
						...(initialization ? textResult({ initialization }).content : []),
						{
							type: "text",
							text: `Question widget requested. Call ask_assert({"questionId":"${question.id}"}) next.`,
						},
					],
				});
				return {
					...result,
					structuredContent: { ...result.structuredContent, question },
				};
			}),
		);

		server.registerTool(
			"ask_assert",
			{
				title: "Confirm question display",
				description:
					"Confirm that an ask widget loaded. Call immediately after ask with question.id. Fails after 10 seconds and marks an unanswered question skipped; answers arrive separately as webAnswer.",
				inputSchema: z.object({
					questionId: z.string().describe("question.id returned by ask"),
				}),
				outputSchema: questionSchema,
				annotations: toolAnnotations,
			},
			handle(async ({ questionId }, context) => {
				const question = await broker.assertQuestion(
					context.chatId,
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

		server.registerTool(
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
				annotations: toolAnnotations,
				_meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
			},
			async ({ questionId, answer, loaded = false }, context) => {
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
			},
		);

		server.registerResource(
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
								"A question the user can answer or revise.",
						},
					},
				],
			}),
		);
	}

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
						"session for this operation; becomes the default if none is set",
					),
			}),
			annotations: toolAnnotations,
		},
		handle(async (args, context) => {
			const { inputs, ...inspected } = await broker.tools(
				context.chatId,
				args.sessionId,
				args.names,
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
			);
			return finishResult(
				broker,
				context,
				textResult(
					{
						session: inspected.session,
						tools: inspected.tools,
						...(inspected.initialization
							? { initialization: inspected.initialization }
							: {}),
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
						"session for this operation; becomes the default if none is set",
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
			description: transferDescription,
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
				"Read the current native transcript, including ongoing work. Re-read a range to see updates to existing entries.",
			inputSchema: historyInput.extend({
				sessionId: z
					.string()
					.optional()
					.describe("session to read; defaults to this chat's session"),
			}),
			outputSchema,
			annotations: toolAnnotations,
		},
		handle(async ({ sessionId, ...range }, context) => {
			const { history, ...session } = await broker.history(
				context.chatId,
				sessionId,
				range,
				context.mcpReq._meta?.["otunnel/requestId"],
				context.mcpReq.signal,
			);
			const { content, ...page } = history;
			return formatResult(
				{
					content: [
						...textResult({ ...session, history: page }).content,
						...content,
					],
				},
				context.chatId,
			);
		}),
	);

	server.registerTool(
		"sessions",
		{
			title: "Sessions",
			description:
				"List online Chappie sessions and this conversation's default target.",
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
				},
				inputs,
			);
			return finishResult(broker, context, result);
		}),
	);

	server.registerResource(
		"Session resource",
		new ResourceTemplate(
			"chappie://session/{sessionId}/{kind}/{id}/{name}{?chatId}",
			{
				list: undefined,
			},
		),
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
	const answers = broker.answers(chatId);
	const content = [
		...result.content,
		...deliveryContent(deliveries),
		...answerContent(answers),
	];
	await broker.acknowledge(deliveries, answers, context.mcpReq.signal);
	return formatResult({ ...result, content }, chatId);
}

function formatResult<
	T extends { content: ReturnType<typeof toolResult>["content"] },
>(result: T, chatId: string) {
	const content = result.content.map((block) => {
		if (block.type !== "resource_link") return block;
		const uri = new URL(block.uri);
		uri.searchParams.set("chatId", chatId);
		return { ...block, uri: uri.href };
	});
	return {
		...result,
		content,
		structuredContent: {
			text: content
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
