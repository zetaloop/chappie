import { randomUUID } from "node:crypto";
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
import type {
	Plugin,
	PluginInput,
	PluginModule,
	ToolDefinition,
} from "@opencode-ai/plugin";
import type { FilePart, Message, Part } from "@opencode-ai/sdk";
import type { Command, Session as NativeSession } from "@opencode-ai/sdk/v2";
import type { Source } from "./activity.ts";
import type { Config } from "./config.ts";
import { readConfig } from "./config.ts";
import {
	type HistoryEntry,
	type HistoryRange,
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

type SessionInfo = Pick<
	NativeSession,
	"id" | "directory" | "title" | "model" | "agent" | "revert"
>;

type Transcript = { info: Message; parts: Part[] }[];
const sessions = new Map<string, OpenSession>();
const usage: LanguageModelV3Usage = {
	inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 0, text: 0, reasoning: 0 },
};

class OpenSession implements Host {
	readonly session: Session;
	readonly tools;
	readonly #input: PluginInput;
	readonly #inputs = new Map<string, SessionInput>();
	readonly #controls = new Set<string>();
	info: SessionInfo;
	model: { providerID: string; modelID: string } | undefined;
	busy = false;
	output: Output | undefined;
	catalog: ToolInfo[] | undefined;
	firstPrompt = "";

	constructor(info: SessionInfo, input: PluginInput, config: Config) {
		this.info = info;
		this.#input = input;
		this.model = info.model
			? { providerID: info.model.providerID, modelID: info.model.id }
			: undefined;
		this.session = new Session(this, config);
		this.tools = localTools(this.session);
	}

	describe() {
		return {
			id: this.info.id,
			agent: "opencode",
			cwd: this.info.directory,
			device: hostname(),
			name: this.info.title,
			...(this.model
				? { model: `${this.model.providerID}/${this.model.modelID}` }
				: {}),
		};
	}
	active(): boolean {
		return this.model?.providerID === "chappie";
	}
	isIdle(): boolean {
		return !this.busy;
	}
	async inspect(signal: AbortSignal): Promise<Environment> {
		if (!this.catalog) await this.session.ready(signal);
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
		const result = await this.#input.client.command.list({
			throwOnError: true,
		});
		return {
			tools: this.catalog ?? [],
			skills: ((result.data ?? []) as Command[])
				.filter((command) => command.source === "skill")
				.map((command) => ({
					name: command.name,
					description: command.description ?? "",
				})),
			...(globalAgents ? { globalAgents } : {}),
		};
	}
	async transcript(): Promise<Transcript> {
		const result = await this.#input.client.session.messages({
			path: { id: this.info.id },
			throwOnError: true,
		});
		return result.data ?? [];
	}
	async history(range: HistoryRange) {
		const entries: HistoryEntry[] = [];
		for (const { info, parts } of await this.transcript()) {
			if (
				this.#controls.has(info.id) ||
				(info.role === "user" && parts.length === 0)
			)
				continue;
			if (this.info.revert && info.id >= this.info.revert.messageID) break;
			const content = await messageContent(parts);
			const origin = parts.find(
				(part) => "metadata" in part && part.metadata?.chappie,
			);
			const source =
				origin && "metadata" in origin
					? (origin.metadata?.chappie as Source | undefined)
					: undefined;
			const calls = parts.flatMap((part) =>
				part.type === "tool"
					? [
							{
								type: "toolCall" as const,
								id: part.callID,
								name: part.tool,
								arguments: part.state.input,
							},
						]
					: [],
			);
			entries.push({
				id: info.id,
				type: "message",
				message: {
					...info,
					content: [...content, ...calls],
					...(source ? { chappie: source } : {}),
				},
				...("created" in info.time
					? { timestamp: new Date(info.time.created).toISOString() }
					: {}),
			});
			for (const part of parts) {
				if (part.type !== "tool") continue;
				entries.push({
					id: part.id,
					type: "message",
					message: {
						role: "toolResult",
						...(await resultFromPart(part)),
						state: part.state,
					},
					...("time" in part.state
						? { timestamp: new Date(part.state.time.start).toISOString() }
						: {}),
				});
			}
		}
		return historyResult(entries, this.info.id, range);
	}
	inputs(): SessionInput[] {
		const values = [...this.#inputs.values()];
		this.#inputs.clear();
		return values;
	}
	resetInputs(): void {
		this.#inputs.clear();
	}
	async input(info: Extract<Message, { role: "user" }>, parts: Part[]) {
		if (this.#controls.has(info.id)) return;
		const content = await messageContent(parts);
		if (!this.firstPrompt)
			this.firstPrompt = content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join(" ");
		this.#inputs.set(info.id, {
			id: info.id,
			sessionId: this.info.id,
			message: { role: "user", timestamp: info.time.created, content },
		});
		this.session.historyChanged();
	}
	async wake(): Promise<void> {
		if (this.busy) return;
		const messageID = `msg_${Date.now().toString(16)}${randomUUID().replaceAll("-", "")}`;
		this.#controls.add(messageID);
		await this.#input.client.session.promptAsync({
			path: { id: this.info.id },
			body: {
				messageID,
				parts: [],
				model: { providerID: "chappie", modelID: "chatgpt" },
				...(this.info.agent ? { agent: this.info.agent } : {}),
			},
			throwOnError: true,
		});
	}
	async abort(): Promise<void> {
		await this.#input.client.session.abort({
			path: { id: this.info.id },
			throwOnError: true,
		});
	}
	async finish(): Promise<void> {
		const output = this.output;
		if (!output?.closed) return;
		const ids = new Set(
			output.message.content.flatMap((block) =>
				block.type === "toolCall" ? [block.id] : [],
			),
		);
		const results: ToolResultMessage[] = [];
		if (ids.size) {
			for (const { parts } of await this.transcript())
				for (const part of parts) {
					if (
						part.type === "tool" &&
						ids.has(part.callID) &&
						(part.state.status === "completed" || part.state.status === "error")
					)
						results.push(await resultFromPart(part));
				}
		}
		if (this.output === output) {
			this.session.complete(output.message, results);
			this.output = undefined;
		}
	}
	async stream(options: LanguageModelV3CallOptions) {
		await this.finish();
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
		let cancelled = false;
		const native = new ReadableStream<LanguageModelV3StreamPart>({
			start: (controller) => {
				const output = new ProviderOutput(
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
				this.output = output;
				queueMicrotask(() => {
					void this.session
						.start(output)
						.catch((error: unknown) => output.fail(error));
				});
			},
			cancel: () => {
				cancelled = true;
				this.output?.fail(new Error("Provider stream cancelled"), true);
			},
		});
		return { stream: native };
	}
}

const plugin: Plugin = async (input) => {
	const config = await readConfig();
	const owned = new Set<string>();
	async function get(id: string): Promise<OpenSession> {
		let state = sessions.get(id);
		if (!state) {
			const response = await input.client.session.get({
				path: { id },
				throwOnError: true,
			});
			if (!response.data) throw new Error(`Session ${id} is unavailable`);
			const existing = sessions.get(id);
			if (existing) return existing;
			state = new OpenSession(response.data as SessionInfo, input, config);
			sessions.set(id, state);
			owned.add(id);
			state.session.update();
		}
		return state;
	}
	queueMicrotask(() => {
		void input.client.session
			.list({ throwOnError: true })
			.then(async ({ data }) => {
				for (const info of data ?? [])
					if ((info as SessionInfo).model?.providerID === "chappie")
						await get(info.id);
			})
			.catch((error: unknown) =>
				input.client.app.log({
					body: {
						service: "chappie",
						level: "error",
						message: error instanceof Error ? error.message : String(error),
					},
				}),
			);
	});
	const tools: Record<string, ToolDefinition> = Object.fromEntries(
		definitions.map((definition) => [
			definition.name,
			{
				description: definition.description,
				args: definition.parameters.shape as unknown as ToolDefinition["args"],
				async execute(
					args: unknown,
					context: { sessionID: string; abort: AbortSignal },
				) {
					const state = await get(context.sessionID);
					const tool = state.tools.find(
						(tool) => tool.name === definition.name,
					);
					if (!tool) throw new Error(`Unknown tool: ${definition.name}`);
					const result = await tool.execute(args, context.abort);
					const output = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
					if (result.isError) throw new Error(output);
					return {
						output,
						metadata:
							result.details && typeof result.details === "object"
								? { ...result.details }
								: {},
						attachments: result.content.flatMap((block) =>
							block.type === "image"
								? [
										{
											type: "file" as const,
											mime: block.mimeType,
											url: `data:${block.mimeType};base64,${block.data}`,
										},
									]
								: [],
						),
					};
				},
			},
		]),
	);
	return {
		tool: tools,
		async config(configuration) {
			configuration.provider ??= {};
			configuration.provider.chappie = {
				name: "Chappie",
				npm: import.meta.url,
				models: {
					chatgpt: {
						name: "ChatGPT",
						attachment: true,
						tool_call: true,
						reasoning: false,
						limit: { context: 1_000_000_000, output: 1_000_000_000 },
						modalities: { input: ["text", "image"], output: ["text"] },
						cost: { input: 0, output: 0 },
					},
				},
			};
		},
		async "chat.message"(_request, output) {
			const state = await get(output.message.sessionID);
			state.model = output.message.model;
			state.session.update();
			await state.input(output.message, output.parts);
		},
		async "chat.params"(request) {
			const state = await get(request.sessionID);
			state.model = request.message.model;
			state.session.update();
			request.message.tools ??= {};
			for (const name of Object.keys(tools))
				request.message.tools[name] = state.active()
					? name === "transfer"
					: state.session.localTools;
		},
		async "chat.headers"(request, output) {
			await get(request.sessionID);
			output.headers["x-chappie-session"] = request.sessionID;
			output.headers["x-chappie-agent"] = request.agent;
		},
		async event({ event }) {
			if (
				event.type === "session.created" ||
				event.type === "session.updated"
			) {
				const state = await get(event.properties.info.id);
				state.info = event.properties.info as SessionInfo;
				if (state.info.model)
					state.model = {
						providerID: state.info.model.providerID,
						modelID: state.info.model.id,
					};
				state.session.update();
			} else if (event.type === "session.deleted") {
				const id = event.properties.info.id;
				sessions.get(id)?.session.close();
				sessions.delete(id);
				owned.delete(id);
			} else if (event.type === "session.status") {
				const state = await get(event.properties.sessionID);
				state.busy = event.properties.status.type !== "idle";
				if (!state.busy) {
					await state.finish();
					await state.session.settled();
				}
			} else if (
				event.type === "message.part.updated" ||
				event.type === "message.part.removed" ||
				event.type === "message.updated" ||
				event.type === "message.removed"
			) {
				const properties = event.properties;
				const id =
					"info" in properties
						? properties.info.sessionID
						: "part" in properties
							? properties.part.sessionID
							: properties.sessionID;
				sessions.get(id)?.session.historyChanged();
			}
		},
		async dispose() {
			for (const id of owned) {
				sessions.get(id)?.session.close();
				sessions.delete(id);
			}
		},
	};
};

export default { id: "chappie", server: plugin } satisfies PluginModule;

export function createChappie() {
	const languageModel = (modelId: string): LanguageModelV3 => {
		const model: LanguageModelV3 = {
			specificationVersion: "v3",
			provider: "chappie",
			modelId,
			supportedUrls: {},
			async doStream(options) {
				const state = sessions.get(
					options.headers?.["x-chappie-session"] ?? "",
				);
				if (!state) throw new Error("OpenCode session is unavailable");
				const purpose = options.headers?.["x-chappie-agent"];
				if (
					purpose === "title" ||
					purpose === "summary" ||
					purpose === "compaction"
				) {
					const text =
						purpose === "title"
							? state.firstPrompt.split("\n")[0]?.slice(0, 100) ||
								state.info.title
							: JSON.stringify(await state.transcript());
					return {
						stream: new ReadableStream<LanguageModelV3StreamPart>({
							start(controller) {
								controller.enqueue({ type: "stream-start", warnings: [] });
								controller.enqueue({ type: "text-start", id: "text" });
								controller.enqueue({
									type: "text-delta",
									id: "text",
									delta: text,
								});
								controller.enqueue({ type: "text-end", id: "text" });
								controller.enqueue({
									type: "finish",
									finishReason: { unified: "stop", raw: "stop" },
									usage,
								});
								controller.close();
							},
						}),
					};
				}
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
	};
	return { languageModel };
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

async function messageContent(parts: Part[]): Promise<Content[]> {
	const content: Content[] = [];
	for (const part of parts) {
		if (part.type === "text" && !part.ignored)
			content.push({ type: "text", text: part.text });
		else if (part.type === "file") content.push(await attachment(part));
		else if (part.type === "reasoning")
			content.push({ type: "text", text: part.text });
	}
	return content;
}

async function attachment(
	file: Pick<FilePart, "url" | "mime" | "filename">,
): Promise<Content> {
	if (!file.mime.startsWith("image/"))
		return { type: "text", text: JSON.stringify({ file }) };
	let data: Buffer;
	if (file.url.startsWith("file:"))
		data = await readFile(fileURLToPath(file.url));
	else {
		const response = await fetch(file.url);
		if (!response.ok)
			throw new Error(`Image request failed with HTTP ${response.status}`);
		data = Buffer.from(await response.arrayBuffer());
	}
	return { type: "image", data: data.toString("base64"), mimeType: file.mime };
}

async function resultFromPart(
	part: Extract<Part, { type: "tool" }>,
): Promise<ToolResultMessage> {
	const state = part.state;
	const content: Content[] = [
		{
			type: "text",
			text:
				state.status === "completed"
					? state.output
					: state.status === "error"
						? state.error
						: state.status,
		},
	];
	if (state.status === "completed")
		for (const file of state.attachments ?? [])
			content.push(await attachment(file));
	return {
		toolCallId: part.callID,
		toolName: part.tool,
		content,
		isError: state.status === "error",
		...("metadata" in state && state.metadata
			? { details: state.metadata }
			: {}),
	};
}
