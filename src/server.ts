import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import packageJson from "../package.json" with { type: "json" };
import type { Broker } from "./broker.ts";

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
			const initialized = await broker.initialize(
				chatId,
				args.sessionId,
				context.mcpReq.signal,
			);
			return textResult(initialized);
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
			const message = await broker.chat(
				chatId,
				args.sessionId,
				args.text,
				context.mcpReq.signal,
			);
			return textResult({ message });
		},
	);

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
			return textResult({
				binding: chatId ? (broker.binding(chatId) ?? null) : null,
				sessions: broker.listSessions(args.sessionId),
			});
		},
	);

	return server;
}

function textResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
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
