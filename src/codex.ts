import { access, readFile, realpath } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import mime from "mime";
import { AppServer, type RpcMessage } from "./appserver.ts";
import { type Config, readConfig } from "./config.ts";
import {
	type HistoryEntry,
	type HistoryRange,
	historyPage,
	historyResult,
} from "./history.ts";
import type {
	Content,
	Environment,
	Host,
	Output,
	ToolResultMessage,
} from "./host.ts";
import type { SessionInput } from "./ipc.ts";
import { definitions, localTools } from "./local.ts";
import {
	type ResponseDefinition,
	ResponsesOutput,
	type ResponsesRequest,
	responseContent,
	responseTools,
} from "./responses.ts";
import { Session } from "./session.ts";

const codexHome = await realpath(
	process.env.CODEX_HOME ?? join(homedir(), ".codex"),
);

interface Thread {
	id: string;
	cwd: string;
	name: string | null;
	model: string | null;
	modelProvider: string;
	status: { type: string };
}

interface Item {
	id: string;
	type: string;
	content?: Record<string, unknown>[];
	contentItems?: Record<string, unknown>[] | null;
	path?: string;
	success?: boolean | null;
	text?: string;
	output?: unknown;
	aggregatedOutput?: string;
	status?: string;
	exitCode?: number | null;
	error?: unknown;
	result?: {
		content: Record<string, unknown>[];
		structuredContent?: { details?: unknown } | null;
	} | null;
	[key: string]: unknown;
}

interface Turn {
	id: string;
	status: string;
	items: Item[];
	error?: { message: string } | null;
}

interface Page<T> {
	data: T[];
	nextCursor: string | null;
}

class CodexSession implements Host {
	readonly session: Session;
	readonly tools;
	readonly #server: AppServer;
	readonly #inputs = new Map<string, SessionInput>();
	readonly #seenInputs = new Set<string>();
	readonly #results = new Map<string, Item>();
	#attached = false;
	thread: Thread;
	turn: string | undefined;
	output: Output | undefined;
	catalog: ResponseDefinition[] | undefined;

	constructor(thread: Thread, server: AppServer, config: Config) {
		this.thread = thread;
		this.#server = server;
		this.session = new Session(this, config);
		this.tools = localTools(this.session);
	}

	describe() {
		return {
			id: this.thread.id,
			agent: "codex",
			cwd: this.thread.cwd,
			device: hostname(),
			...(this.thread.name ? { name: this.thread.name } : {}),
			...(this.thread.model
				? { model: `${this.thread.modelProvider}/${this.thread.model}` }
				: {}),
		};
	}

	active(): boolean {
		return this.thread.modelProvider === "chappie";
	}

	isIdle(): boolean {
		return this.thread.status.type === "idle";
	}

	async inspect(signal: AbortSignal): Promise<Environment> {
		await this.session.ready(signal);
		const result = await this.#server.request<{
			data: { skills: { name: string; description: string; path: string }[] }[];
		}>("skills/list", { cwds: [this.thread.cwd] });
		const path = join(codexHome, "AGENTS.md");
		let globalAgents: { path: string } | undefined;
		try {
			await access(path);
			globalAgents = { path };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return {
			tools: (this.catalog ?? []).map(({ wire: _wire, ...tool }) => tool),
			skills: result.data.flatMap((entry) => entry.skills),
			...(globalAgents ? { globalAgents } : {}),
		};
	}

	async history(range: HistoryRange) {
		const items: {
			id: string;
			item: Item;
			turnId: string;
			startedAtMs: number | null;
			completedAtMs: number | null;
		}[] = [];
		let cursor: string | null = null;
		do {
			const page: Page<{
				item: Item;
				turnId: string;
				startedAtMs: number | null;
				completedAtMs: number | null;
			}> = await this.#server.request("thread/items/list", {
				threadId: this.thread.id,
				sortDirection: "desc",
				limit: range.limit + 1,
				...(cursor ? { cursor } : {}),
			});
			for (const entry of page.data) {
				const item = entry.item;
				if (item.type === "userMessage" && !item.content?.length) continue;
				items.push({ ...entry, id: item.id });
			}
			cursor = page.nextCursor;
			if (range.after) {
				if (items.some((entry) => entry.id === range.after)) break;
			} else {
				const anchor = range.before
					? items.findIndex((entry) => entry.id === range.before)
					: -1;
				if (
					(!range.before || anchor !== -1) &&
					items.length - anchor - 1 > range.limit
				)
					break;
			}
		} while (cursor);
		const page = historyPage(items.reverse(), range);
		const entries = await Promise.all(
			page.entries.map(async (entry) => {
				const timestamp = entry.startedAtMs ?? entry.completedAtMs;
				return {
					...(await itemMessage(entry.item)),
					id: entry.id,
					turnId: entry.turnId,
					...(timestamp !== null
						? { timestamp: new Date(timestamp).toISOString() }
						: {}),
				} satisfies HistoryEntry;
			}),
		);
		return historyResult(
			{
				entries,
				hasMore: page.hasMore || (!range.after && cursor !== null),
			},
			this.thread.id,
		);
	}

	inputs(): SessionInput[] {
		const inputs = [...this.#inputs.values()];
		this.#inputs.clear();
		return inputs;
	}

	resetInputs(): void {
		this.#inputs.clear();
	}

	async wake(): Promise<void> {
		if (!this.isIdle()) return;
		this.thread.status = { type: "active" };
		try {
			const result = await this.#server.request<{ turn: Turn }>("turn/start", {
				threadId: this.thread.id,
				input: [],
			});
			this.turn = result.turn.id;
		} catch (error) {
			this.thread.status = { type: "idle" };
			throw error;
		}
	}

	async abort(): Promise<void> {
		if (this.turn)
			await this.#server.request("turn/interrupt", {
				threadId: this.thread.id,
				turnId: this.turn,
			});
	}

	async item(item: Item): Promise<void> {
		if (!this.active()) return;
		if (
			this.output?.message.content.some(
				(call) => call.type === "toolCall" && call.id === item.id,
			)
		)
			this.#results.set(item.id, item);
		if (
			item.type === "userMessage" &&
			item.content?.length &&
			!this.#seenInputs.has(item.id)
		) {
			this.#seenInputs.add(item.id);
			this.#inputs.set(item.id, {
				id: item.id,
				sessionId: this.thread.id,
				message: {
					role: "user",
					timestamp: Date.now(),
					content: (await itemMessage(item)).content,
				},
			});
		}
		this.session.historyChanged();
	}

	async respond(
		request: ResponsesRequest,
		response: ServerResponse,
		signal: AbortSignal,
	): Promise<void> {
		if (!this.#attached) {
			// A new thread is materialized before its first provider request.
			const result = await this.#server.request<{
				thread: Thread;
				initialTurnsPage: Page<Turn>;
			}>("thread/resume", {
				threadId: this.thread.id,
				excludeTurns: true,
				initialTurnsPage: { limit: 1, itemsView: "full" },
			});
			this.thread = result.thread;
			for (const turn of result.initialTurnsPage.data) {
				if (turn.status === "inProgress") this.turn = turn.id;
				for (const item of turn.items) await this.item(item);
			}
			this.#attached = true;
		}
		const previous = this.output;
		if (previous) {
			const results: ToolResultMessage[] = [];
			for (const call of previous.message.content) {
				if (call.type !== "toolCall") continue;
				const item = request.input?.findLast(
					(item) =>
						item.call_id === call.id &&
						(item.type === "function_call_output" ||
							item.type === "custom_tool_call_output"),
				);
				if (!item)
					throw new Error(
						`Codex returned no output for ${call.name} (${call.id})`,
					);
				const native = this.#results.get(call.id);
				results.push({
					toolCallId: call.id,
					toolName: call.name,
					content: responseContent(item.output),
					isError: itemFailed(native),
					...(native?.result?.structuredContent?.details
						? { details: native.result.structuredContent.details }
						: {}),
				});
			}
			this.session.complete(previous.message, results);
			this.output = undefined;
			this.#results.clear();
		}
		const metadata = request.client_metadata?.["x-codex-turn-metadata"];
		const kind = metadata
			? (JSON.parse(metadata) as { request_kind?: string }).request_kind
			: undefined;
		if (kind === "compaction") {
			const output = new ResponsesOutput(request, [], response, signal);
			try {
				await this.session.generate(output, { kind, input: request });
			} catch (error) {
				output.fail(error);
			}
			return;
		}
		this.catalog = responseTools(request.tools ?? []).flatMap((tool) => {
			const local = ["chappie", "mcp__chappie"].includes(
				tool.wire.namespace ?? "",
			)
				? definitions.find((definition) => definition.name === tool.wire.name)
				: undefined;
			return local
				? local.name === "transfer"
					? [{ ...tool, name: local.name }]
					: []
				: [tool];
		});
		const output = new ResponsesOutput(request, this.catalog, response, signal);
		this.output = output;
		try {
			await this.session.start(output);
		} catch (error) {
			output.fail(error);
		}
	}

	async settled(turn: Turn): Promise<void> {
		this.thread.status = { type: "idle" };
		this.turn = undefined;
		const output = this.output;
		if (output) {
			if (!output.closed)
				output.fail(
					new Error(turn.error?.message ?? "Codex turn ended"),
					turn.status === "interrupted",
				);
			const results = await Promise.all(
				output.message.content
					.flatMap((call) => (call.type === "toolCall" ? [call] : []))
					.map(async (call): Promise<ToolResultMessage> => {
						const item = this.#results.get(call.id);
						return {
							toolCallId: call.id,
							toolName: call.name,
							content: item
								? (await itemMessage(item)).content
								: [
										{
											type: "text",
											text: turn.error?.message ?? `Codex turn ${turn.status}`,
										},
									],
							isError:
								!item || item.status === "inProgress" || itemFailed(item),
							...(item?.result?.structuredContent?.details
								? { details: item.result.structuredContent.details }
								: {}),
						};
					}),
			);
			this.session.complete(
				output.message,
				results,
				turn.status === "completed"
					? undefined
					: (turn.error?.message ?? `Codex turn ${turn.status}`),
			);
			this.output = undefined;
		}
		this.#results.clear();
		this.#seenInputs.clear();
		this.catalog = undefined;
		await this.session.settled(
			turn.error ? new Error(turn.error.message) : undefined,
		);
	}
}

function itemFailed(item: Item | undefined): boolean {
	return Boolean(
		item &&
			(["failed", "declined", "interrupted"].includes(item.status ?? "") ||
				item.success === false ||
				(typeof item.exitCode === "number" && item.exitCode !== 0)),
	);
}

async function image(path: string): Promise<Content> {
	return {
		type: "image",
		data: (await readFile(path)).toString("base64"),
		mimeType: mime.getType(path) ?? "image/png",
	};
}

async function itemMessage(
	item: Item,
): Promise<Record<string, unknown> & { content: Content[] }> {
	const message: Record<string, unknown> = { ...item };
	let content: Content[];
	switch (item.type) {
		case "userMessage":
			delete message.content;
			message.role = "user";
			content = (
				await Promise.all(
					(item.content ?? []).map(async (block): Promise<Content[]> => {
						if (block.type === "text" && typeof block.text === "string")
							return [{ type: "text", text: block.text }];
						if (block.type === "localImage" && typeof block.path === "string")
							return [await image(block.path)];
						if (block.type === "image" && typeof block.url === "string")
							return responseContent([
								{ type: "input_image", image_url: block.url },
							]);
						return [{ type: "text", text: JSON.stringify(block) }];
					}),
				)
			).flat();
			break;
		case "agentMessage":
			delete message.text;
			message.role = "assistant";
			content = [{ type: "text", text: item.text ?? "" }];
			break;
		case "functionCallOutput":
			delete message.output;
			content = responseContent(item.output);
			break;
		case "mcpToolCall":
			if (item.result) {
				const { content: blocks, ...metadata } = item.result;
				message.result = metadata;
				if (metadata.structuredContent?.details)
					message.details = metadata.structuredContent.details;
				content = responseContent(blocks);
			} else {
				delete message.error;
				content = [{ type: "text", text: JSON.stringify(item.error) ?? "" }];
			}
			break;
		case "commandExecution":
			delete message.aggregatedOutput;
			content = [{ type: "text", text: item.aggregatedOutput ?? "" }];
			break;
		case "imageView":
			if (typeof item.path !== "string")
				throw new Error("Codex image item has no path");
			content = [await image(item.path)];
			break;
		case "dynamicToolCall":
			delete message.contentItems;
			content = responseContent(item.contentItems ?? []);
			break;
		default:
			return {
				type: item.type,
				content: [{ type: "text", text: JSON.stringify(item) }],
			};
	}
	return { ...message, content };
}

export async function serveCodex(): Promise<void> {
	const config = await readConfig();
	const appServer = config.codex?.appServer ?? "unix://";
	const sessions = new Map<string, CodexSession>();
	const loading = new Map<string, Promise<CodexSession>>();
	const clients = new Set<ServerResponse>();
	const stopped = Promise.withResolvers<void>();
	const stop = (): void => stopped.resolve();
	let events = Promise.resolve();
	const rpc = new AppServer((message) => {
		events = events
			.then(() => receive(message))
			.catch((error: unknown) => console.error(error));
	});
	function register(thread: Thread): CodexSession {
		let state = sessions.get(thread.id);
		if (state) state.thread = thread;
		else {
			state = new CodexSession(thread, rpc, config);
			sessions.set(thread.id, state);
		}
		state.session.update();
		return state;
	}
	const get = (threadId: string): Promise<CodexSession> => {
		const existing = sessions.get(threadId);
		if (existing) return Promise.resolve(existing);
		let pending = loading.get(threadId);
		if (!pending) {
			pending = rpc
				.request<{ thread: Thread }>("thread/read", { threadId })
				.then(({ thread }) => register(thread))
				.finally(() => loading.delete(threadId));
			loading.set(threadId, pending);
		}
		return pending;
	};
	async function receive(message: RpcMessage): Promise<void> {
		const params = message.params;
		if (!params) return;
		if (message.id !== undefined) return;
		if (message.method === "thread/started") {
			const thread = params.thread as Thread;
			register(thread);
			return;
		}
		if (typeof params.threadId !== "string") return;
		const state = sessions.get(params.threadId);
		if (!state) return;
		switch (message.method) {
			case "thread/settings/updated": {
				const settings = params.threadSettings as {
					cwd: string;
					model: string;
					modelProvider: string;
				};
				Object.assign(state.thread, settings);
				state.session.update();
				break;
			}
			case "thread/name/updated":
				state.thread.name =
					typeof params.threadName === "string" ? params.threadName : null;
				state.session.update();
				break;
			case "thread/status/changed":
				state.thread.status = params.status as Thread["status"];
				break;
			case "thread/closed":
			case "thread/archived":
			case "thread/deleted":
				state.session.close();
				sessions.delete(params.threadId);
				break;
			case "turn/started":
				state.turn = (params.turn as Turn).id;
				state.thread.status = { type: "active" };
				break;
			case "turn/completed":
				await state.settled(params.turn as Turn);
				break;
			case "item/started":
			case "item/completed":
				await state.item(params.item as Item);
				break;
		}
	}
	const server = createServer((request, response) => {
		void handle(request, response).catch((error: unknown) => {
			if (response.headersSent)
				response.destroy(error instanceof Error ? error : undefined);
			else {
				response.writeHead(500, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						error: {
							message: error instanceof Error ? error.message : String(error),
						},
					}),
				);
			}
		});
	});
	async function handle(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		const route = new URL(request.url ?? "/", "http://localhost").pathname;
		const controller = new AbortController();
		response.on("close", () => {
			if (!response.writableEnded)
				controller.abort(new Error("Codex request cancelled"));
		});
		if (request.method === "GET" && route === "/client") {
			await connected;
			clients.add(response);
			response.once("close", () => {
				clients.delete(response);
				if (clients.size === 0) stop();
			});
			response.writeHead(200);
			response.flushHeaders();
			return;
		}
		if (request.method === "GET" && route === "/") {
			await connected;
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ name: "chappie", codexHome, appServer }));
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(404);
			response.end();
			return;
		}
		await connected;
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
			string,
			unknown
		>;
		if (route === "/v1/responses") {
			const threadId = request.headers["thread-id"];
			if (typeof threadId !== "string")
				throw new Error("Codex did not provide a thread-id header");
			const state = await get(threadId);
			await events;
			if (!state.active()) {
				const { thread } = await rpc.request<{ thread: Thread }>(
					"thread/read",
					{ threadId },
				);
				register(thread);
			}
			await state.respond(
				body as unknown as ResponsesRequest,
				response,
				controller.signal,
			);
			return;
		}
		if (route === "/resource") {
			if (typeof body.threadId !== "string" || typeof body.uri !== "string")
				throw new Error("Resource requests require threadId and uri");
			const state = await get(body.threadId);
			const resource = await state.session.resource(
				body.uri,
				controller.signal,
			);
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify(resource));
			return;
		}
		if (route.startsWith("/tools/")) {
			if (typeof body.threadId !== "string")
				throw new Error("Codex did not provide threadId metadata");
			const state = await get(body.threadId);
			const name = decodeURIComponent(route.slice("/tools/".length));
			const tool = state.tools.find((tool) => tool.name === name);
			if (!tool) throw new Error(`Unknown Chappie tool: ${name}`);
			const result = await tool.execute(body.arguments, controller.signal);
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify(result));
			return;
		}
		response.writeHead(404);
		response.end();
	}
	let connected: Promise<void>;
	try {
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(config.codex?.port ?? 24275, "127.0.0.1", resolve);
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			const response = await fetch(
				`http://127.0.0.1:${config.codex?.port ?? 24275}`,
			);
			const service = (await response.json()) as {
				name?: string;
				codexHome?: string;
				appServer?: string;
			};
			if (!response.ok || service.name !== "chappie") throw error;
			if (service.codexHome !== codexHome || service.appServer !== appServer)
				throw new Error(
					`Chappie port ${config.codex?.port ?? 24275} is serving another Codex connection: ${service.codexHome} (${service.appServer})`,
				);
			process.send?.({ ready: true });
			return;
		}
		connected = rpc.connect(appServer);
		await connected;
		process.send?.({ ready: true });
		let cursor: string | null = null;
		do {
			const page: Page<string> = await rpc.request(
				"thread/loaded/list",
				cursor ? { cursor } : {},
			);
			for (const id of page.data) {
				try {
					await get(id);
				} catch (error) {
					console.error(error);
				}
			}
			cursor = page.nextCursor;
		} while (cursor);
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		await Promise.race([stopped.promise, rpc.closed]);
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	} finally {
		for (const state of sessions.values()) state.session.close();
		rpc.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
