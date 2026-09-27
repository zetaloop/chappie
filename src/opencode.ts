import { access, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3Content,
	LanguageModelV3StreamPart,
	LanguageModelV3Usage,
} from "@ai-sdk/provider";
import {
	OpenCode,
	type OpenCodeClient,
	type SessionInfo,
	type SessionMessageInfo,
	type SessionMessageUser,
} from "@opencode/client";
import { discover, headers } from "@opencode/client/service";
import type { Model, Plugin, Provider } from "@opencode/plugin";
import * as z from "zod";
import { type Config, readConfig } from "./config.ts";
import { toolResultsContent } from "./delivery.ts";
import {
	type HistoryEntry,
	type HistoryRange,
	type HistoryResult,
	historyPage,
	historyResult,
} from "./history.ts";
import type {
	Content,
	Environment,
	Host,
	Output,
	ToolInfo,
	ToolResultMessage,
} from "./host.ts";
import type { SessionInput } from "./ipc.ts";
import { definitions, localTools } from "./local.ts";
import {
	createMessage,
	ProviderOutput,
	type StreamEvent,
	type StreamMessage,
} from "./provider.ts";
import { Session } from "./session.ts";

const usage: LanguageModelV3Usage = {
	inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 0, text: 0, reasoning: 0 },
};

type Client = () => Promise<OpenCodeClient>;
const sessions = new Map<string, OpenSession>();

class OpenSession implements Host {
	readonly session: Session;
	readonly tools;
	readonly #context: Plugin.Context;
	readonly #client: Client;
	readonly #inputs = new Map<string, SessionInput>();
	readonly #results = new Map<string, ToolResultMessage>();
	#step: PromiseWithResolvers<void> | undefined;
	info: SessionInfo;
	busy = false;
	output: Output | undefined;
	catalog: ToolInfo[] | undefined;

	constructor(
		info: SessionInfo,
		context: Plugin.Context,
		client: Client,
		config: Config,
	) {
		this.info = info;
		this.#context = context;
		this.#client = client;
		this.session = new Session(this, config);
		this.tools = localTools(this.session);
	}

	describe() {
		return {
			id: this.info.id,
			agent: "opencode",
			cwd: this.info.location.directory,
			device: hostname(),
			...(this.info.title ? { name: this.info.title } : {}),
			...(this.info.model
				? { model: `${this.info.model.providerID}/${this.info.model.id}` }
				: {}),
		};
	}
	active(): boolean {
		return this.info.model?.providerID === "chappie";
	}
	isIdle(): boolean {
		return !this.busy;
	}
	async inspect(signal: AbortSignal): Promise<Environment> {
		await this.session.ready(signal);
		const path = join(
			process.env.OPENCODE_CONFIG_DIR ??
				join(
					process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
					"opencode",
				),
			"AGENTS.md",
		);
		let globalAgents: { path: string } | undefined;
		try {
			await access(path);
			globalAgents = { path };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const result = await this.#context.skill.list();
		return {
			tools: this.catalog ?? [],
			skills: result.data.map((skill) => ({
				name: skill.name,
				description: skill.description ?? "",
			})),
			...(globalAgents ? { globalAgents } : {}),
		};
	}
	async history(range: HistoryRange): Promise<HistoryResult> {
		const client = await this.#client();
		const messages: SessionMessageInfo[] = [];
		let cursor: string | undefined;
		do {
			const page = await client.message.list({
				sessionID: this.info.id,
				limit: 200,
				...(cursor ? { cursor } : { order: "asc" as const }),
			});
			messages.push(...page.data);
			cursor = page.cursor.next ?? undefined;
		} while (cursor);
		const end = messages.findIndex(
			(message) =>
				message.id === this.info.revert?.messageID ||
				(message.type === "assistant" &&
					message.time.completed === undefined) ||
				(message.type === "compaction" && message.status === "running") ||
				(message.type === "shell" && message.time.completed === undefined),
		);
		const page = historyPage(
			end === -1 ? messages : messages.slice(0, end),
			range,
			(message) => message.type !== "synthetic" || !message.metadata?.chappie,
		);
		const entries = await Promise.all(
			page.entries.map((message) => historyEntry(message, this.info.id)),
		);
		return {
			...historyResult(entries, this.info.id, { limit: range.limit }),
			hasMore: page.hasMore,
		};
	}
	inputs(): SessionInput[] {
		const values = [...this.#inputs.values()];
		this.#inputs.clear();
		return values;
	}
	resetInputs(): void {
		this.#inputs.clear();
	}
	input(message: SessionMessageUser): void {
		if (!this.active()) return;
		this.#inputs.set(message.id, {
			id: message.id,
			sessionId: this.info.id,
			message: {
				role: "user",
				timestamp: message.time.created,
				content: userContent(message),
			},
		});
	}
	async wake(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			await this.#context.session.synthetic({
				sessionID: this.info.id,
				text: "",
				metadata: { chappie: true },
			});
		} catch (error) {
			this.busy = false;
			throw error;
		}
	}
	async abort(): Promise<void> {
		await this.#context.session.interrupt({ sessionID: this.info.id });
	}
	async result(
		id: string,
		content: Parameters<typeof toolContent>[0],
		isError: boolean,
		details?: unknown,
	): Promise<void> {
		const call = this.output?.message.content.find(
			(block) => block.type === "toolCall" && block.id === id,
		);
		if (call?.type !== "toolCall") return;
		this.#results.set(id, {
			toolCallId: id,
			toolName: call.name,
			content: await toolContent(content),
			isError,
			...(details ? { details } : {}),
		});
	}
	finish(error?: string): void {
		const output = this.output;
		if (!output) return;
		if (!output.closed)
			output.fail(
				new Error(error ?? "OpenCode step ended before its provider response"),
			);
		this.session.complete(output.message, [...this.#results.values()], error);
		this.output = undefined;
		this.#results.clear();
		this.#step?.resolve();
		this.#step = undefined;
	}
	close(): void {
		this.session.close();
		this.output = undefined;
		this.#results.clear();
		this.#step?.resolve();
		this.#step = undefined;
	}
	async settled(error?: Error): Promise<void> {
		if (this.output) return;
		this.busy = false;
		this.catalog = undefined;
		await this.session.settled(error);
	}
	async stream(options: LanguageModelV3CallOptions) {
		const kind = options.headers?.["x-chappie-kind"];
		if (!kind) throw new Error("OpenCode did not provide a model request kind");
		const generation = kind !== "primary";
		if (!generation) await this.#step?.promise;
		options.abortSignal?.throwIfAborted();
		if (!generation) {
			this.#step = Promise.withResolvers<void>();
			this.catalog = (options.tools ?? []).flatMap((tool) =>
				tool.type === "function"
					? [
							{
								name: tool.name,
								description: tool.description ?? "",
								parameters: { ...tool.inputSchema },
							},
						]
					: [],
			);
		}
		let cancelled = false;
		let output: Output | undefined;
		const native = new ReadableStream<LanguageModelV3StreamPart>({
			start: (controller) => {
				const response = new ProviderOutput(
					createMessage(
						{ api: "chappie", provider: "chappie", id: "chatgpt" },
						"stop",
					),
					{
						push: (event) => {
							if (!cancelled) streamEvent(controller, event);
						},
						end: () => {
							if (!cancelled) controller.close();
						},
					},
					options.abortSignal,
				);
				output = response;
				if (!generation) this.output = response;
				queueMicrotask(() => {
					const { abortSignal: _signal, headers: _headers, ...input } = options;
					void (
						generation
							? this.session.generate(response, { kind, input })
							: this.session.start(response)
					).catch((error: unknown) => response.fail(error));
				});
			},
			cancel: () => {
				cancelled = true;
				output?.fail(new Error("Provider stream cancelled"), true);
			},
		});
		return { stream: native };
	}
}

export default {
	id: "chappie",
	async setup(context) {
		const config = await readConfig();
		const owned = new Set<string>();
		const controller = new AbortController();
		let connection: OpenCodeClient | undefined;
		async function client(): Promise<OpenCodeClient> {
			if (connection) return connection;
			const endpoint = config.opencode
				? {
						url: config.opencode.url,
						...(config.opencode.password
							? {
									auth: {
										type: "basic" as const,
										username: "opencode",
										password: config.opencode.password,
									},
								}
							: {}),
					}
				: await discover();
			if (!endpoint)
				throw new Error(
					"OpenCode service is unavailable; configure opencode.url for a standalone server",
				);
			const api = OpenCode.make({
				baseUrl: endpoint.url,
				headers: headers({
					url: endpoint.url,
					...(endpoint.auth ? { auth: endpoint.auth } : {}),
				}),
			});
			const info = await api.server.info({ signal: controller.signal });
			if (info.pid !== process.pid)
				throw new Error("OpenCode endpoint belongs to another server process");
			connection = api;
			return api;
		}
		async function get(id: string): Promise<OpenSession> {
			const existing = sessions.get(id);
			if (existing) return existing;
			const info = await context.session.get({ sessionID: id });
			const previous = sessions.get(id);
			if (previous) return previous;
			const state = new OpenSession(info, context, client, config);
			sessions.set(id, state);
			owned.add(id);
			state.session.update();
			return state;
		}
		const providerID = "chappie" as Provider.ID;
		const modelID = "chatgpt" as Model.ID;
		await context.provider.transform((editor) =>
			editor.add({
				info: {
					id: providerID,
					name: "Chappie",
					activation: "enabled",
					package: `aisdk:${import.meta.url}`,
				},
				models: [
					{
						id: modelID,
						modelID,
						providerID,
						name: "ChatGPT",
						capabilities: {
							tools: true,
							input: ["text", "image"],
							output: ["text"],
						},
						variants: [],
						time: { released: 0 },
						cost: [],
						status: "active",
						enabled: true,
						limit: { context: 1_000_000_000, output: 1_000_000_000 },
					},
				],
			}),
		);
		await context.tool.transform((editor) => {
			for (const definition of definitions)
				editor.add({
					name: definition.name,
					description: definition.description,
					input: z.toJSONSchema(definition.parameters),
					options: { codemode: false },
					async execute(args, toolContext) {
						const state = await get(toolContext.sessionID);
						const tool = state.tools.find(
							(tool) => tool.name === definition.name,
						);
						if (!tool) throw new Error(`Unknown tool: ${definition.name}`);
						const result = await tool.execute(args, toolContext.signal);
						return {
							content: result.content.map((block) =>
								block.type === "image"
									? {
											type: "file" as const,
											uri: `data:${block.mimeType};base64,${block.data}`,
											mime: block.mimeType,
										}
									: block,
							),
							...(result.details && typeof result.details === "object"
								? { metadata: { ...result.details } }
								: {}),
						};
					},
				});
		});
		await context.session.hook("context", async (event) => {
			const state = await get(event.sessionID);
			state.info.model = {
				id: event.model.id,
				providerID: event.model.providerID,
				...(event.model.variant ? { variant: event.model.variant } : {}),
			};
			state.busy = true;
			state.session.update();
			for (const tool of definitions)
				if (
					state.active() ? tool.name !== "transfer" : !state.session.localTools
				)
					delete event.tools[tool.name];
			if (state.active()) {
				event.messages = [];
				event.system = [];
			}
		});
		await context.session.hook(
			"model.request",
			async (event) => {
				await get(event.sessionID);
				event.headers["x-chappie-kind"] = event.kind;
			},
			{ providerID },
		);

		const report = (error: unknown) => {
			if (!controller.signal.aborted) console.error(error);
		};
		const scanning = (async () => {
			const api = await client();
			const active = await api.session.active({ signal: controller.signal });
			let cursor: string | undefined;
			do {
				const page = await api.session.list(
					{
						directory: context.location.directory,
						...(cursor ? { cursor } : {}),
					},
					{ signal: controller.signal },
				);
				for (const info of page.data) {
					if (info.model?.providerID !== providerID) continue;
					const state = await get(info.id);
					state.busy = Boolean(active[info.id]);
				}
				cursor = page.cursor.next ?? undefined;
			} while (cursor);
		})().catch(report);
		const listening = (async () => {
			for await (const event of context.event.subscribe({
				signal: controller.signal,
			})) {
				if (
					!("sessionID" in event.data) ||
					typeof event.data.sessionID !== "string"
				)
					continue;
				const id = event.data.sessionID;
				if (
					!sessions.has(id) &&
					event.location?.directory !== context.location.directory
				)
					continue;
				if (event.type === "session.deleted") {
					sessions.get(id)?.close();
					sessions.delete(id);
					owned.delete(id);
					continue;
				}
				const state = await get(id);
				if (event.type === "session.model.selected") {
					state.info.model = event.data.model;
					state.catalog = undefined;
					state.session.update();
				} else if (event.type === "session.renamed") {
					state.info.title = event.data.title;
					state.session.update();
				} else if (
					event.type === "session.moved" ||
					event.type === "session.revert.staged" ||
					event.type === "session.revert.cleared" ||
					event.type === "session.revert.committed"
				) {
					state.info = await context.session.get({ sessionID: id });
					state.session.update();
				} else if (event.type === "session.inbox.delivered" && state.active()) {
					const api = await client();
					const message = await api.session.message.get(
						{ sessionID: id, messageID: event.data.inboxID },
						{ signal: controller.signal },
					);
					if (message.type === "user") state.input(message);
				} else if (event.type === "session.tool.success") {
					await state.result(
						event.data.id,
						event.data.content,
						false,
						event.data.metadata,
					);
				} else if (event.type === "session.tool.failed") {
					await state.result(
						event.data.id,
						[
							...(event.data.content ?? []),
							{ type: "text", text: event.data.error.message },
						],
						true,
						event.data.metadata,
					);
				} else if (
					event.type === "session.step.ended" ||
					event.type === "session.step.failed"
				) {
					state.finish(
						event.type === "session.step.failed"
							? event.data.error.message
							: undefined,
					);
				} else if (event.type === "session.execution.started") {
					state.busy = true;
				} else if (
					event.type === "session.execution.succeeded" ||
					event.type === "session.execution.failed" ||
					event.type === "session.execution.interrupted"
				) {
					await state.settled(
						event.type === "session.execution.failed"
							? new Error(event.data.error.message)
							: event.type === "session.execution.interrupted"
								? new Error(
										`OpenCode execution interrupted: ${event.data.reason}`,
									)
								: undefined,
					);
				}
				state.session.historyChanged();
			}
		})().catch(report);
		return async () => {
			controller.abort();
			for (const id of owned) {
				sessions.get(id)?.close();
				sessions.delete(id);
			}
			await Promise.all([scanning, listening]);
		};
	},
} satisfies Plugin.Plugin;

export function createChappie() {
	return { languageModel };
}

function languageModel(modelId: string): LanguageModelV3 {
	const model: LanguageModelV3 = {
		specificationVersion: "v3",
		provider: "chappie",
		modelId,
		supportedUrls: {},
		async doStream(options) {
			const id = options.headers?.["x-opencode-session"];
			if (!id) throw new Error("OpenCode did not provide a session ID");
			const state = sessions.get(id);
			if (!state) throw new Error("OpenCode session is unavailable");
			return state.stream(options);
		},
		async doGenerate(options) {
			const { stream } = await model.doStream(options);
			const content: LanguageModelV3Content[] = [];
			let finishReason: { unified: "stop" | "tool-calls"; raw: string } = {
				unified: "stop",
				raw: "stop",
			};
			for await (const part of stream) {
				if (part.type === "text-delta") {
					const last = content.at(-1);
					if (last?.type === "text") last.text += part.delta;
					else content.push({ type: "text", text: part.delta });
				} else if (part.type === "tool-call") {
					content.push(part);
					finishReason = { unified: "tool-calls", raw: "toolUse" };
				} else if (part.type === "error") throw part.error;
			}
			return { content, finishReason, usage, warnings: [] };
		},
	};
	return model;
}

function streamEvent<M extends StreamMessage>(
	controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
	event: StreamEvent<M>,
): void {
	const id = "contentIndex" in event ? String(event.contentIndex) : "";
	const message =
		"partial" in event
			? event.partial
			: event.type === "done"
				? event.message
				: event.type === "error"
					? event.error
					: undefined;
	const metadata = message?.chappie
		? { providerMetadata: { chappie: { ...message.chappie } } }
		: {};
	switch (event.type) {
		case "start":
			controller.enqueue({ type: "stream-start", warnings: [] });
			break;
		case "text_start":
			controller.enqueue({ type: "text-start", id });
			break;
		case "text_delta":
			controller.enqueue({ type: "text-delta", id, delta: event.delta });
			break;
		case "text_end":
			controller.enqueue({ type: "text-end", id, ...metadata });
			break;
		case "toolcall_end":
			controller.enqueue({
				type: "tool-call",
				toolCallId: event.toolCall.id,
				toolName: event.toolCall.name,
				input: JSON.stringify(event.toolCall.arguments),
				...metadata,
			});
			break;
		case "done":
			controller.enqueue({
				type: "finish",
				finishReason: {
					unified: event.reason === "toolUse" ? "tool-calls" : "stop",
					raw: event.reason,
				},
				usage,
				...metadata,
			});
			break;
		case "error":
			controller.enqueue({
				type: "error",
				error: new Error(event.error.errorMessage ?? "Provider cancelled"),
			});
			break;
	}
}

function userContent(message: SessionMessageUser): Content[] {
	return [
		{ type: "text", text: message.text },
		...(message.files ?? []).map(
			(file): Content =>
				file.mime.startsWith("image/")
					? { type: "image", data: file.data, mimeType: file.mime }
					: {
							type: "text",
							text: JSON.stringify({
								file: { mime: file.mime, name: file.name, source: file.source },
							}),
						},
		),
	];
}

async function toolContent(
	blocks: readonly (
		| { type: "text"; text: string }
		| { type: "file"; uri: string; mime: string }
	)[],
): Promise<Content[]> {
	return Promise.all(
		blocks.map(async (block): Promise<Content> => {
			if (block.type === "text") return block;
			if (!block.mime.startsWith("image/"))
				return { type: "text", text: JSON.stringify({ file: block }) };
			let data: Buffer;
			if (block.uri.startsWith("file:"))
				data = await readFile(fileURLToPath(block.uri));
			else {
				const response = await fetch(block.uri);
				if (!response.ok)
					throw new Error(`Image request failed with HTTP ${response.status}`);
				data = Buffer.from(await response.arrayBuffer());
			}
			return {
				type: "image",
				data: data.toString("base64"),
				mimeType: block.mime,
			};
		}),
	);
}

async function historyEntry(
	message: SessionMessageInfo,
	sessionId: string,
): Promise<HistoryEntry> {
	const record: Record<string, unknown> = { ...message, role: message.type };
	const content: HistoryResult["content"] = [];
	switch (message.type) {
		case "user":
			delete record.text;
			delete record.files;
			content.push(...userContent(message));
			break;
		case "assistant":
			delete record.content;
			if (message.providerState?.chappie)
				record.chappie = message.providerState.chappie;
			for (const part of message.content) {
				if (part.type === "text" || part.type === "reasoning")
					content.push({ type: "text", text: part.text });
				else {
					content.push({
						type: "text",
						text: JSON.stringify({
							toolCallId: part.id,
							toolName: part.name,
							arguments: part.state.input,
							time: part.time,
						}),
					});
					if (
						part.state.status === "completed" ||
						part.state.status === "error"
					) {
						const result: ToolResultMessage = {
							toolCallId: part.id,
							toolName: part.name,
							content: await toolContent(
								part.state.content ?? [
									{
										type: "text",
										text:
											part.state.status === "error"
												? part.state.error.message
												: "",
									},
								],
							),
							isError: part.state.status === "error",
							...(part.state.metadata ? { details: part.state.metadata } : {}),
						};
						content.push(...toolResultsContent([result], sessionId));
					}
				}
			}
			break;
		case "compaction":
			if (message.status === "completed") {
				delete record.summary;
				delete record.recent;
				delete record.providerContext;
				content.push(
					{ type: "text", text: message.summary },
					{ type: "text", text: message.recent },
				);
			}
			break;
		case "shell":
			delete record.output;
			content.push({
				type: "text",
				text: JSON.stringify(message.output) ?? "",
			});
			break;
		default:
			if ("text" in message) {
				delete record.text;
				content.push({ type: "text", text: message.text });
			}
	}
	return {
		id: message.id,
		type: "message",
		timestamp: new Date(message.time.created).toISOString(),
		message: { ...record, content },
	};
}
