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
import { Desktop, type DesktopMessage } from "./desktop.ts";
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

interface RequestMetadata {
	request_kind?: string;
	thread_source?: string;
	turn_id?: string;
}

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
	input?: Record<string, unknown>[];
	serverUserMessageId?: string | null;
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
		_meta?: { details?: unknown } | null;
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

async function* loaded(connection: AppServer): AsyncGenerator<string> {
	let cursor: string | null = null;
	do {
		const page: Page<string> = await connection.request(
			"thread/loaded/list",
			cursor ? { cursor } : {},
		);
		yield* page.data;
		cursor = page.nextCursor;
	} while (cursor);
}

interface DesktopTurn {
	turnId: string | null;
	status: string;
	items: Item[];
	error?: Turn["error"];
	turnStartedAtMs?: number;
	durationMs?: number | null;
}

interface Snapshot {
	id: string;
	cwd: string;
	title: string | null;
	latestModel: string;
	modelProvider: string;
	latestThreadSettings?: { model: string; modelProvider: string; cwd: string };
	threadRuntimeStatus?: Thread["status"];
	turns: DesktopTurn[];
	turnHistory?: {
		kind: "canonical";
		history: {
			entitiesByKey: Record<string, DesktopTurn>;
			islands: { entries: { value: string }[] }[];
		};
	};
}

interface Patch {
	op: string;
	path: (string | number)[];
	value?: unknown;
}

type Connection = AppServer | { desktop: Desktop; owner: string };

function desktopThread(snapshot: Snapshot): Thread {
	return {
		id: snapshot.id,
		cwd: snapshot.latestThreadSettings?.cwd ?? snapshot.cwd,
		name: snapshot.title,
		model: snapshot.latestThreadSettings?.model ?? snapshot.latestModel,
		modelProvider:
			snapshot.latestThreadSettings?.modelProvider ?? snapshot.modelProvider,
		status: snapshot.threadRuntimeStatus ?? { type: "idle" },
	};
}

function desktopTurns(
	snapshot: Snapshot,
): { key: string | number; turn: DesktopTurn }[] {
	const history = snapshot.turnHistory?.history;
	return history
		? history.islands.flatMap((island) =>
				island.entries.map(({ value }) => ({
					key: value,
					turn: history.entitiesByKey[value] as DesktopTurn,
				})),
			)
		: snapshot.turns.map((turn, key) => ({ key, turn }));
}

class CodexSession implements Host {
	readonly session: Session;
	readonly tools;
	readonly connection: Connection;
	readonly #inputs = new Map<string, SessionInput>();
	readonly #seenInputs = new Set<string>();
	readonly #results = new Map<string, Item>();
	#attached = false;
	#desktopTurn: string | number | undefined;
	thread: Thread;
	turn: string | undefined;
	output: Output | undefined;
	catalog: ResponseDefinition[] | undefined;

	constructor(thread: Thread, connection: Connection, config: Config) {
		this.thread = thread;
		this.connection = connection;
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
		return (
			this.thread.modelProvider === "chappie" &&
			this.thread.status.type !== "notLoaded"
		);
	}

	isIdle(): boolean {
		return (
			this.thread.status.type === "idle" ||
			this.thread.status.type === "systemError"
		);
	}

	async inspect(signal: AbortSignal): Promise<Environment> {
		await this.session.ready(signal);
		const request =
			this.connection instanceof AppServer
				? this.connection.request.bind(this.connection)
				: AppServer.query;
		const result = await request<{
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
		if (!(this.connection instanceof AppServer)) {
			const { desktop, owner } = this.connection;
			await desktop.request(
				"thread-follower-load-complete-history",
				{ conversationId: this.thread.id },
				1,
				owner,
				300_000,
			);
			const snapshot = await desktop.snapshot<Snapshot>(this.thread.id, owner);
			const page = historyPage(
				desktopTurns(snapshot).flatMap(({ turn }) =>
					turn.items.map((item) => ({
						id: item.id,
						item,
						turnId: turn.turnId,
						timestamp: turn.turnStartedAtMs,
					})),
				),
				range,
			);
			return historyResult(
				{
					entries: await Promise.all(
						page.entries.map(async ({ item, turnId, timestamp }) => ({
							...(await itemMessage(item)),
							id: item.id,
							turnId,
							...(timestamp === undefined
								? {}
								: { timestamp: new Date(timestamp).toISOString() }),
						})),
					),
					hasMore: page.hasMore,
				},
				this.thread.id,
			);
		}
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
			}> = await this.connection.request("thread/items/list", {
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
			const input = { threadId: this.thread.id, input: [] };
			if (this.connection instanceof AppServer) {
				const result = await this.connection.request<{ turn: Turn }>(
					"turn/start",
					input,
				);
				this.turn = result.turn.id;
			} else {
				await this.connection.desktop.request(
					"thread-follower-start-turn",
					{ conversationId: this.thread.id, turnStart: { request: input } },
					2,
					this.connection.owner,
				);
			}
		} catch (error) {
			this.thread.status = { type: "idle" };
			throw error;
		}
	}

	async abort(): Promise<void> {
		if (!this.turn) return;
		if (this.connection instanceof AppServer)
			await this.connection.request("turn/interrupt", {
				threadId: this.thread.id,
				turnId: this.turn,
			});
		else
			await this.connection.desktop.request(
				"thread-follower-interrupt-turn",
				{
					conversationId: this.thread.id,
					mode: "user-stop",
					expectedTurnId: this.turn,
				},
				4,
				this.connection.owner,
			);
	}

	async item(item: Item): Promise<void> {
		await this.#capture(item);
		this.session.historyChanged();
	}

	async #capture(item: Item): Promise<void> {
		if (!this.active()) return;
		if (
			this.output?.message.content.some(
				(call) => call.type === "toolCall" && call.id === item.id,
			)
		)
			this.#results.set(item.id, item);
		const id =
			item.type === "userMessage"
				? item.id
				: item.type === "steeringUserMessage"
					? item.serverUserMessageId
					: undefined;
		if (
			id &&
			(item.content ?? item.input)?.length &&
			!this.#seenInputs.has(id)
		) {
			this.#seenInputs.add(id);
			this.#inputs.set(id, {
				id,
				sessionId: this.thread.id,
				message: {
					role: "user",
					timestamp: Date.now(),
					content: (await itemMessage(item)).content,
				},
			});
		}
	}

	async snapshot(snapshot: Snapshot): Promise<void> {
		Object.assign(this.thread, desktopThread(snapshot));
		const turns = desktopTurns(snapshot);
		const current =
			turns.find(({ turn }) => turn.turnId === this.turn) ??
			turns.findLast(({ turn }) => turn.status === "inProgress");
		if (current) {
			this.#desktopTurn = current.key;
			if (current.turn.turnId) this.turn = current.turn.turnId;
			for (const item of current.turn.items) await this.#capture(item);
			if (current.turn.turnId && current.turn.status !== "inProgress")
				await this.settled({
					id: current.turn.turnId,
					status: current.turn.status,
					items: current.turn.items,
					error: current.turn.error ?? null,
				});
		}
		this.session.update();
	}

	async patches(patches: Patch[]): Promise<void> {
		if (this.connection instanceof AppServer) return;
		let refresh = false;
		for (const patch of patches) {
			if (
				[
					"title",
					"cwd",
					"latestModel",
					"modelProvider",
					"latestThreadSettings",
					"threadRuntimeStatus",
				].includes(String(patch.path[0]))
			)
				refresh = true;
			const path =
				patch.path[0] === "turnHistory" &&
				patch.path[1] === "history" &&
				patch.path[2] === "entitiesByKey"
					? patch.path.slice(3)
					: patch.path[0] === "turns"
						? patch.path.slice(1)
						: [];
			if (path[0] !== this.#desktopTurn) continue;
			if (
				path.length === 1 ||
				path[1] === "status" ||
				path[1] === "error" ||
				path[1] === "turnId"
			)
				refresh = true;
			if (path[1] === "items" && patch.op !== "remove") {
				if (path.length === 2 && Array.isArray(patch.value))
					for (const item of patch.value) await this.#capture(item as Item);
				else if (
					path.length === 3 &&
					patch.value &&
					typeof patch.value === "object"
				)
					await this.#capture(patch.value as Item);
			}
		}
		if (refresh)
			await this.snapshot(
				await this.connection.desktop.snapshot<Snapshot>(
					this.thread.id,
					this.connection.owner,
				),
			);
		this.session.historyChanged();
	}

	async respond(
		request: ResponsesRequest,
		context: RequestMetadata | undefined,
		response: ServerResponse,
		signal: AbortSignal,
	): Promise<void> {
		if (context?.request_kind === "turn" && context.turn_id)
			this.turn = context.turn_id;
		if (!this.#attached) {
			if (this.connection instanceof AppServer) {
				// A new thread is materialized before its first provider request.
				const result = await this.connection.request<{
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
			} else {
				await this.snapshot(
					await this.connection.desktop.snapshot<Snapshot>(
						this.thread.id,
						this.connection.owner,
					),
				);
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
					...(native?.result?._meta?.details
						? { details: native.result._meta.details }
						: {}),
				});
			}
			this.session.complete(previous.message, results);
			this.output = undefined;
			this.#results.clear();
		}
		const kind = context?.request_kind;
		if (kind === "compaction") {
			const output = new ResponsesOutput(request, [], response, signal);
			try {
				await this.session.generate(output, { kind, input: request });
			} catch (error) {
				output.fail(error);
			}
			return;
		}
		this.catalog = responseTools(request.tools ?? []).map((tool) => {
			const local = ["chappie", "mcp__chappie"].includes(
				tool.wire.namespace ?? "",
			)
				? definitions.find((definition) => definition.name === tool.wire.name)
				: undefined;
			return local ? { ...tool, name: local.name } : tool;
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
							...(item?.result?._meta?.details
								? { details: item.result._meta.details }
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
		this.#desktopTurn = undefined;
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
		case "steeringUserMessage":
		case "userMessage":
			delete message.content;
			delete message.input;
			delete message.restoreMessage;
			delete message.compareKey;
			message.role = "user";
			content = (
				await Promise.all(
					(item.content ?? item.input ?? []).map(
						async (block): Promise<Content[]> => {
							if (block.type === "text" && typeof block.text === "string")
								return [{ type: "text", text: block.text }];
							if (block.type === "localImage" && typeof block.path === "string")
								return [await image(block.path)];
							if (block.type === "image" && typeof block.url === "string")
								return responseContent([
									{ type: "input_image", image_url: block.url },
								]);
							return [{ type: "text", text: JSON.stringify(block) }];
						},
					),
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
				if (metadata._meta?.details) message.details = metadata._meta.details;
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
	let rpc: AppServer | undefined;
	let desktop: Desktop | undefined;
	let connecting: Promise<void> | undefined;
	function register(thread: Thread, connection: Connection): CodexSession {
		let state = sessions.get(thread.id);
		if (
			state &&
			state.connection !== connection &&
			(state.connection instanceof AppServer ||
				connection instanceof AppServer ||
				state.connection.desktop !== connection.desktop ||
				state.connection.owner !== connection.owner)
		) {
			state.session.close();
			state = undefined;
		}
		if (state) state.thread = thread;
		else {
			state = new CodexSession(thread, connection, config);
			sessions.set(thread.id, state);
		}
		state.session.update();
		return state;
	}
	function disconnected(connection: AppServer | Desktop): void {
		if (connection === rpc) rpc = undefined;
		if (connection === desktop) desktop = undefined;
		for (const [id, state] of sessions)
			if (
				state.connection === connection ||
				(!(state.connection instanceof AppServer) &&
					state.connection.desktop === connection)
			) {
				state.session.close();
				sessions.delete(id);
			}
	}
	function attach(): Promise<void> {
		connecting ??= (async () => {
			if (!desktop) {
				const connection = new Desktop((message) => {
					events = events
						.then(async () => {
							await connecting;
							await receiveDesktop(connection, message);
						})
						.catch((error: unknown) => console.error(error));
				});
				try {
					await connection.connect(codexHome);
					desktop = connection;
					void connection.closed.then(() => disconnected(connection));
				} catch (error) {
					connection.close();
					if (
						!["ENOENT", "ECONNREFUSED"].includes(
							(error as NodeJS.ErrnoException).code ?? "",
						)
					)
						throw error;
				}
			}
			if (!rpc) {
				let available = Boolean(config.codex?.appServer);
				if (!available) {
					try {
						await access(
							join(codexHome, "app-server-control", "app-server-control.sock"),
						);
						available = true;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
				}
				if (available) {
					const connection = new AppServer((message) => {
						events = events
							.then(async () => {
								await connecting;
								await receive(message, connection);
							})
							.catch((error: unknown) => console.error(error));
					});
					await connection.connect(appServer);
					rpc = connection;
					void connection.closed.then(() => disconnected(connection));
					for await (const threadId of loaded(connection)) {
						try {
							const { thread } = await connection.request<{ thread: Thread }>(
								"thread/read",
								{ threadId },
							);
							register(thread, connection);
						} catch (error) {
							console.error(error);
						}
					}
				}
			}
		})().finally(() => {
			connecting = undefined;
		});
		return connecting;
	}
	const get = (threadId: string, control = false): Promise<CodexSession> => {
		const existing = sessions.get(threadId);
		if (existing && (!control || existing.thread.status.type !== "notLoaded"))
			return Promise.resolve(existing);
		let pending = loading.get(threadId);
		if (!pending) {
			pending = (async () => {
				if (rpc) {
					for await (const id of loaded(rpc)) {
						if (id !== threadId) continue;
						const { thread } = await rpc.request<{ thread: Thread }>(
							"thread/read",
							{ threadId },
						);
						return register(thread, rpc);
					}
				}
				if (desktop) {
					const owner = await desktop.owner(threadId);
					if (owner) {
						const snapshot = await desktop.snapshot<Snapshot>(threadId, owner);
						const state = register(desktopThread(snapshot), { desktop, owner });
						await state.snapshot(snapshot);
						return state;
					}
				}
				if (!control && rpc) {
					const { thread } = await rpc.request<{ thread: Thread }>(
						"thread/read",
						{ threadId },
					);
					return register(thread, rpc);
				}
				throw new Error(`No connected Codex client owns thread ${threadId}`);
			})().finally(() => loading.delete(threadId));
			loading.set(threadId, pending);
		}
		return pending;
	};
	async function receiveDesktop(
		connection: Desktop,
		message: DesktopMessage,
	): Promise<void> {
		const params = message.params;
		if (!params) return;
		if (
			message.method === "client-status-changed" &&
			params.status === "disconnected"
		) {
			for (const [id, state] of sessions)
				if (
					!(state.connection instanceof AppServer) &&
					state.connection.owner === params.clientId
				) {
					state.session.close();
					sessions.delete(id);
				}
			return;
		}
		if (params.hostId !== "local" || typeof params.conversationId !== "string")
			return;
		const threadId = params.conversationId;
		if (
			(message.method === "thread-stream-following-changed" &&
				params.following === true) ||
			message.method === "thread-stream-following-status-requested"
		) {
			if (sessions.has(threadId) || !message.sourceClientId) return;
			const owner =
				message.method === "thread-stream-following-status-requested"
					? message.sourceClientId
					: await connection.owner(threadId, message.sourceClientId);
			if (owner) {
				const snapshot = await connection.snapshot<Snapshot>(threadId, owner);
				await register(desktopThread(snapshot), {
					desktop: connection,
					owner,
				}).snapshot(snapshot);
			}
			return;
		}
		const state = sessions.get(threadId);
		if (
			!state ||
			state.connection instanceof AppServer ||
			state.connection.desktop !== connection ||
			state.connection.owner !== message.sourceClientId
		)
			return;
		if (message.method === "thread-stream-state-changed") {
			const change = params.change as {
				type: string;
				conversationState: Snapshot;
				patches: Patch[];
			};
			if (change.type === "snapshot")
				await state.snapshot(change.conversationState);
			else if (change.type === "patches") await state.patches(change.patches);
		} else if (message.method === "thread-archived") {
			state.session.close();
			sessions.delete(threadId);
		}
	}
	async function receive(
		message: RpcMessage,
		connection: AppServer,
	): Promise<void> {
		const params = message.params;
		if (!params) return;
		if (message.id !== undefined) return;
		if (message.method === "thread/started") {
			const thread = params.thread as Thread;
			register(thread, connection);
			return;
		}
		if (typeof params.threadId !== "string") return;
		const state = sessions.get(params.threadId);
		if (!state || state.connection !== connection) return;
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
				state.session.update();
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
			await attach();
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
			const payload = body as unknown as ResponsesRequest;
			const metadata = payload.client_metadata?.["x-codex-turn-metadata"];
			const context = metadata
				? (JSON.parse(metadata) as RequestMetadata)
				: undefined;
			// Memory consolidation processes history across sessions.
			if (context?.thread_source === "memory_consolidation") {
				response.writeHead(400, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						error: {
							type: "invalid_request_error",
							code: "unsupported_request",
							message:
								"Background memory generation is not supported by Chappie",
						},
					}),
				);
				return;
			}
			const threadId = request.headers["thread-id"];
			if (typeof threadId !== "string")
				throw new Error("Codex did not provide a thread-id header");
			await attach();
			const state = await get(threadId, true);
			await events;
			if (!state.active()) {
				if (state.connection instanceof AppServer) {
					const { thread } = await state.connection.request<{ thread: Thread }>(
						"thread/read",
						{ threadId },
					);
					register(thread, state.connection);
				} else {
					await state.snapshot(
						await state.connection.desktop.snapshot<Snapshot>(
							threadId,
							state.connection.owner,
						),
					);
				}
			}
			await state.respond(payload, context, response, controller.signal);
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
		connected = attach();
		await connected;
		process.send?.({ ready: true });
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		await stopped.promise;
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	} finally {
		for (const state of sessions.values()) state.session.close();
		rpc?.close();
		desktop?.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
