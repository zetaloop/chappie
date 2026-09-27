import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Content, ToolCall, ToolInfo } from "./host.ts";
import {
	createMessage,
	ProviderOutput,
	type StreamEvent,
	type StreamMessage,
} from "./provider.ts";

export interface ResponseTool {
	type: string;
	name?: string;
	description?: string;
	parameters?: Record<string, unknown>;
	format?: Record<string, unknown>;
	tools?: ResponseTool[];
}

export interface ResponseItem {
	type: string;
	call_id?: string;
	name?: string;
	namespace?: string;
	output?: string | Record<string, unknown>[];
	[key: string]: unknown;
}

export interface ResponsesRequest {
	model: string;
	input?: ResponseItem[];
	tools?: ResponseTool[];
	stream?: boolean;
	client_metadata?: Record<string, string>;
}

export interface ResponseDefinition extends ToolInfo {
	wire: { name: string; namespace?: string; custom: boolean };
}

export function responseTools(
	tools: ResponseTool[],
	namespace?: string,
): ResponseDefinition[] {
	return tools.flatMap((tool): ResponseDefinition[] => {
		if (tool.type === "namespace" && tool.name)
			return responseTools(tool.tools ?? [], tool.name);
		if (!tool.name || (tool.type !== "function" && tool.type !== "custom"))
			return [];
		const custom = tool.type === "custom";
		return [
			{
				name: namespace ? `${namespace}.${tool.name}` : tool.name,
				description: [
					tool.description,
					custom && tool.format ? JSON.stringify(tool.format) : undefined,
				]
					.filter(Boolean)
					.join("\n"),
				parameters: custom
					? {
							type: "object",
							properties: {
								input: {
									type: "string",
									description: "Raw tool input in the declared format",
								},
							},
							required: ["input"],
							additionalProperties: false,
						}
					: (tool.parameters ?? { type: "object", properties: {} }),
				wire: { name: tool.name, ...(namespace ? { namespace } : {}), custom },
			},
		];
	});
}

export function responseContent(output: unknown): Content[] {
	if (!Array.isArray(output))
		return [
			{
				type: "text",
				text:
					typeof output === "string" ? output : (JSON.stringify(output) ?? ""),
			},
		];
	return output.flatMap((value): Content[] => {
		if (!value || typeof value !== "object")
			return [{ type: "text", text: JSON.stringify(value) }];
		const block = value as Record<string, unknown>;
		if (typeof block.text === "string")
			return [{ type: "text", text: block.text }];
		if (
			block.type === "image" &&
			typeof block.data === "string" &&
			typeof block.mimeType === "string"
		)
			return [{ type: "image", data: block.data, mimeType: block.mimeType }];
		const uri =
			block.type === "inputImage"
				? block.imageUrl
				: block.type === "input_image"
					? block.image_url
					: undefined;
		if (typeof uri === "string") {
			const comma = uri.indexOf(",");
			const header = uri.slice(0, comma);
			if (header.startsWith("data:") && header.endsWith(";base64"))
				return [
					{
						type: "image",
						mimeType: header.slice(5, -7),
						data: uri.slice(comma + 1),
					},
				];
		}
		return [{ type: "text", text: JSON.stringify(block) }];
	});
}

export class ResponsesOutput extends ProviderOutput<StreamMessage> {
	readonly #catalog: Map<string, ResponseDefinition>;

	constructor(
		request: ResponsesRequest,
		catalog: ResponseDefinition[],
		response: ServerResponse,
		signal: AbortSignal,
	) {
		const definitions = new Map(catalog.map((tool) => [tool.name, tool]));
		const message = createMessage(
			{ api: "responses", provider: "chappie", id: request.model },
			"pending",
		);
		const items: Record<string, unknown>[] = [];
		const id = `resp_${randomUUID()}`;
		const created = Math.floor(Date.now() / 1000);
		let sequence = 0;
		let heartbeat: NodeJS.Timeout | undefined;
		const snapshot = (status: string) => ({
			id,
			object: "response",
			created_at: created,
			status,
			model: request.model,
			output: items,
			usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
		});
		const event = (type: string, fields: Record<string, unknown>): void => {
			if (response.destroyed || request.stream === false) return;
			response.write(
				`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`,
			);
		};
		const push = (part: StreamEvent<StreamMessage>): void => {
			switch (part.type) {
				case "start":
					response.setHeader(
						"Content-Type",
						request.stream === false ? "application/json" : "text/event-stream",
					);
					event("response.created", { response: snapshot("in_progress") });
					if (request.stream !== false) {
						// Codex applies its idle timeout to SSE events, including in-progress responses.
						heartbeat = setInterval(() => {
							event("response.in_progress", {
								response: snapshot("in_progress"),
							});
						}, 15_000);
					}
					break;
				case "text_start": {
					const item = {
						id: `msg_${randomUUID()}`,
						type: "message",
						role: "assistant",
						status: "in_progress",
						content: [],
					};
					items[part.contentIndex] = item;
					event("response.output_item.added", {
						output_index: part.contentIndex,
						item,
					});
					event("response.content_part.added", {
						item_id: item.id,
						output_index: part.contentIndex,
						content_index: 0,
						part: { type: "output_text", text: "", annotations: [] },
					});
					break;
				}
				case "text_delta":
					event("response.output_text.delta", {
						item_id: items[part.contentIndex]?.id,
						output_index: part.contentIndex,
						content_index: 0,
						delta: part.delta,
					});
					break;
				case "text_end": {
					const item = items[part.contentIndex];
					if (!item) break;
					const content = {
						type: "output_text",
						text: part.content,
						annotations: [],
					};
					item.content = [content];
					item.status = "completed";
					event("response.output_text.done", {
						item_id: item.id,
						output_index: part.contentIndex,
						content_index: 0,
						text: part.content,
					});
					event("response.content_part.done", {
						item_id: item.id,
						output_index: part.contentIndex,
						content_index: 0,
						part: content,
					});
					event("response.output_item.done", {
						output_index: part.contentIndex,
						item,
					});
					break;
				}
				case "toolcall_start": {
					const call = part.partial.content[part.contentIndex];
					if (call?.type !== "toolCall") break;
					const tool = definitions.get(call.name);
					if (!tool) throw new Error(`Unknown Codex tool: ${call.name}`);
					const { custom, ...wire } = tool.wire;
					const item = {
						id: `${custom ? "ctc" : "fc"}_${randomUUID()}`,
						type: custom ? "custom_tool_call" : "function_call",
						call_id: call.id,
						...wire,
						status: "in_progress",
						...(custom ? { input: "" } : { arguments: "" }),
					};
					items[part.contentIndex] = item;
					event("response.output_item.added", {
						output_index: part.contentIndex,
						item,
					});
					break;
				}
				case "toolcall_delta":
					break;
				case "toolcall_end": {
					const item = items[part.contentIndex];
					if (!item) break;
					const custom = item.type === "custom_tool_call";
					const field = custom ? "input" : "arguments";
					const value = custom
						? part.toolCall.arguments.input
						: JSON.stringify(part.toolCall.arguments);
					item[field] = value;
					item.status = "completed";
					const type = custom
						? "response.custom_tool_call_input"
						: "response.function_call_arguments";
					event(`${type}.delta`, {
						item_id: item.id,
						output_index: part.contentIndex,
						delta: value,
					});
					event(`${type}.done`, {
						item_id: item.id,
						output_index: part.contentIndex,
						[field]: value,
					});
					event("response.output_item.done", {
						output_index: part.contentIndex,
						item,
					});
					break;
				}
				case "done": {
					const result = snapshot("completed");
					if (request.stream === false) response.write(JSON.stringify(result));
					else event("response.completed", { response: result });
					break;
				}
				case "error": {
					const result = {
						...snapshot("failed"),
						error: { code: "server_error", message: part.error.errorMessage },
					};
					if (request.stream === false) response.write(JSON.stringify(result));
					else event("response.failed", { response: result });
					break;
				}
			}
		};
		super(
			message,
			{
				push,
				end() {
					clearInterval(heartbeat);
					response.end();
				},
			},
			signal,
		);
		this.#catalog = definitions;
	}

	override toolCalls(calls: ToolCall[]): void {
		try {
			for (const call of calls) {
				const tool = this.#catalog.get(call.name);
				if (!tool) throw new Error(`Unknown Codex tool: ${call.name}`);
				if (tool.wire.custom && typeof call.arguments.input !== "string")
					throw new Error(`${call.name} requires a string input`);
			}
			super.toolCalls(calls);
		} catch (error) {
			this.fail(error);
		}
	}
}
