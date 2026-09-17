import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type {
	AssistantMessage,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { DeliveryRecord } from "./delivery.ts";
import {
	type BrokerMessage,
	IpcClient,
	type SessionDescription,
	type SessionInput,
	type SessionInspection,
	type SessionStatus,
} from "./ipc.ts";
import type { ProviderOutput } from "./provider.ts";
import { readSessionResource, rememberImages } from "./resources.ts";

type RemoteRequest = Extract<BrokerMessage, { type: "chat" | "call" }>;

interface Notice {
	message: string;
	type: "info" | "warning" | "error";
}

interface SyncRequest {
	resolve(): void;
	reject(error: Error): void;
}

interface StoreRequest {
	resolve(): void;
	reject(error: Error): void;
}

interface ActiveRequest {
	request: RemoteRequest;
	session: SessionDescription;
	message: AssistantMessage;
	completed: boolean;
	cancelled: string | undefined;
	toolResults: ToolResultMessage[];
}

export class LocalSession {
	readonly #pi: ExtensionAPI;
	readonly #agentDir: string;
	readonly #connect: string | undefined;
	readonly #syncs = new Map<number, SyncRequest>();
	readonly #stores = new Map<string, StoreRequest>();
	readonly #queue: RemoteRequest[] = [];
	readonly #pendingInputs = new Map<string, SessionInput>();
	readonly #deliveries = new Map<string, DeliveryRecord>();
	#context: ExtensionContext | undefined;
	#connection: IpcClient | undefined;
	#output: ProviderOutput | undefined;
	#active: ActiveRequest | undefined;
	#status: SessionStatus = "idle";
	#nextSyncId = 1;
	#starting = false;
	#sessionId: string | undefined;
	#inputCursor: string | null = null;
	#flushing = Promise.resolve();

	constructor(pi: ExtensionAPI, agentDir: string, connect?: string) {
		this.#pi = pi;
		this.#agentDir = agentDir;
		this.#connect = connect;
	}

	install(): void {
		this.#pi.registerEntryRenderer<Notice>(
			"chappie.notice",
			({ data }, _options, theme) => {
				if (!data) return;
				return new Text(
					theme.fg(data.type === "info" ? "dim" : data.type, data.message),
					1,
					0,
				);
			},
		);
		this.#pi.on("session_start", (_event, context) => this.#update(context));
		this.#pi.on("model_select", (event, context) =>
			this.#update(context, event.model.provider === "chappie"),
		);
		this.#pi.on("session_info_changed", (_event, context) => {
			this.#context = context;
			void this.#sync().catch(() => {});
		});
		this.#pi.on("session_tree", (event, context) => {
			this.#context = context;
			if (context.model?.provider === "chappie") {
				this.#resetInputs(context, event.newLeafId);
			}
		});
		this.#pi.on("context", (event, context) => ({
			messages:
				context.model?.provider === "chappie"
					? []
					: event.messages.filter(
							(message) =>
								message.role !== "custom" ||
								message.customType !== "chappie.request",
						),
		}));
		this.#pi.on("turn_end", (event, context) =>
			this.#turnEnd(event.message, event.toolResults, context),
		);
		this.#pi.on("agent_settled", async (_event, context) => {
			this.#context = context;
			this.#starting = false;
			this.#collectInputs();
			await this.#completeActive();
			this.#dispatch();
		});
		this.#pi.on("session_shutdown", () => this.close());
	}

	#notify(message: string, type: Notice["type"] = "info"): void {
		if (this.#context)
			this.#pi.appendEntry<Notice>("chappie.notice", { message, type });
	}

	async start(output: ProviderOutput): Promise<void> {
		const context = this.#context;
		const connection = this.#connection;
		if (context?.model?.provider !== "chappie" || !connection) {
			throw new Error("Chappie is not active for this session");
		}
		if (this.#output && !this.#output.closed) {
			throw new Error("Chappie already has an active provider request");
		}

		this.#starting = false;
		this.#output = output;
		try {
			await connection.connect();
			if (output.closed) return;
			this.#collectInputs();
			await this.#completeActive();
			this.#status = "ready";
			await this.#sync();
			if (output.closed) return;
			output.begin();
			this.#dispatch();
			await output.finished;
		} finally {
			if (this.#output === output) this.#output = undefined;
			this.#status = this.#active ? "executing" : "idle";
			void this.#sync().catch(() => {});
		}
	}

	close(): void {
		const sessionId = this.#context?.sessionManager.getSessionId();
		if (sessionId && this.#connection?.connected) {
			void this.#connection
				.send({ type: "unregister", sessionId })
				.catch(() => {});
		}
		this.#output?.fail(new Error("Chappie session ended"), true);
		this.#output = undefined;
		this.#active = undefined;
		this.#queue.length = 0;
		this.#starting = false;
		this.#connection?.close();
		this.#connection = undefined;
		this.#context = undefined;
		this.#resetInputs();
		this.#rejectSyncs(new Error("Chappie session ended"));
		this.#rejectStores(new Error("Chappie session ended"));
	}

	#update(
		context: ExtensionContext,
		active = context.model?.provider === "chappie",
	): void {
		this.#context = context;
		if (!active) {
			this.close();
			return;
		}
		if (this.#sessionId !== context.sessionManager.getSessionId()) {
			this.#resetInputs(context);
		}
		if (!this.#connection) {
			this.#connection = new IpcClient(this.#agentDir, this.#connect, {
				onOpen: async () => {
					await this.#sync();
					await this.#flushDeliveries();
				},
				onMessage: (message) => this.#receive(message),
				onClose: (error) => {
					this.#rejectSyncs(error);
					this.#rejectStores(error);
					if (this.#output && !this.#output.closed) this.#output.fail(error);
					else this.#notify(error.message, "error");
					this.#active = undefined;
					this.#queue.length = 0;
					this.#starting = false;
					this.#status = "idle";
				},
			});
			this.#connection.start();
		} else {
			void this.#sync().catch(() => {});
		}
	}

	#description(): SessionDescription {
		const context = this.#context;
		if (!context) throw new Error("Chappie session is not available");
		const name = this.#pi.getSessionName();
		return {
			id: context.sessionManager.getSessionId(),
			cwd: context.cwd,
			device: hostname(),
			status: this.#status,
			...(name ? { name } : {}),
		};
	}

	async #sync(): Promise<void> {
		const connection = this.#connection;
		if (
			!connection?.connected ||
			!this.#context ||
			this.#context.model?.provider !== "chappie"
		)
			return;
		const id = this.#nextSyncId++;
		const completion = Promise.withResolvers<void>();
		this.#syncs.set(id, completion);
		try {
			await connection.send({ type: "sync", id, session: this.#description() });
			await completion.promise;
		} finally {
			this.#syncs.delete(id);
		}
	}

	async #receive(message: BrokerMessage): Promise<void> {
		switch (message.type) {
			case "synced":
				this.#syncs.get(message.id)?.resolve();
				break;
			case "stored":
				this.#stores.get(message.id)?.resolve();
				break;
			case "notice":
				if (
					message.sessionId === this.#context?.sessionManager.getSessionId()
				) {
					this.#notify(message.message);
				}
				break;
			case "inspect":
				await this.#reply(message.id, message.sessionId, async () => {
					const globalAgents = await this.#readGlobalAgents();
					return {
						type: "result",
						id: message.id,
						inspection: this.#inspection(),
						inputs: this.#inputs(),
						...(globalAgents ? { globalAgents } : {}),
					};
				});
				break;
			case "ackInputs":
				if (
					message.sessionId === this.#context?.sessionManager.getSessionId()
				) {
					for (const id of message.ids) this.#pendingInputs.delete(id);
				}
				break;
			case "readResource":
				await this.#reply(message.id, message.sessionId, async () => ({
					type: "result",
					id: message.id,
					resource: await readSessionResource(message.sessionId, message.uri),
				}));
				break;
			case "cancel": {
				const queued = this.#queue.findIndex(
					(request) => request.id === message.id,
				);
				const request =
					this.#queue[queued] ??
					(this.#active?.request.id === message.id
						? this.#active.request
						: undefined);
				if (!request) break;
				const name =
					request.type === "call"
						? [...new Set(request.calls.map((call) => call.name))].join(", ")
						: "chat";
				this.#notify(
					`${name} cancelled for ChatGPT ${request.chatId.slice(-4)}: ${message.reason}`,
					"warning",
				);
				if (queued !== -1) {
					this.#queue.splice(queued, 1);
					break;
				}
				const active = this.#active;
				if (!active) break;
				active.cancelled = message.reason;
				if (active.completed) await this.#completeActive();
				else this.#context?.abort();
				break;
			}
			case "chat":
			case "call":
				if (
					message.sessionId !== this.#context?.sessionManager.getSessionId()
				) {
					await this.#sendError(
						message.id,
						"The requested Pi session is no longer active",
					);
					break;
				}
				this.#queue.push(message);
				this.#dispatch();
				break;
		}
	}

	#inspection(): SessionInspection {
		const activeTools = new Set(this.#pi.getActiveTools());
		this.#collectInputs();
		return {
			session: this.#description(),
			tools: this.#pi
				.getAllTools()
				.filter((tool) => activeTools.has(tool.name)),
			skills: this.#pi
				.getCommands()
				.filter((command) => command.source === "skill"),
		};
	}

	async #readGlobalAgents(): Promise<string | undefined> {
		try {
			return await readFile(join(this.#agentDir, "AGENTS.md"), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	#dispatch(): void {
		if (this.#active) return;
		const request = this.#queue[0];
		if (!request) return;
		const output = this.#output;
		if (!output || output.closed) {
			this.#wake();
			return;
		}

		this.#queue.shift();
		this.#active = {
			request,
			session: this.#description(),
			message: output.message,
			completed: false,
			cancelled: undefined,
			toolResults: [],
		};
		this.#status = "executing";
		void this.#sync().catch(() => {});
		if (request.type === "chat") {
			output.text(request.text);
			output.done();
		} else {
			output.toolCalls(request.calls);
			output.done("toolUse");
		}
	}

	#wake(): void {
		if (
			this.#starting ||
			this.#output ||
			this.#active ||
			this.#queue.length === 0 ||
			!this.#context?.isIdle()
		)
			return;
		this.#starting = true;
		this.#pi.sendMessage(
			{
				customType: "chappie.request",
				content: "",
				display: false,
			},
			{ triggerTurn: true },
		);
	}

	async #turnEnd(
		message: unknown,
		toolResults: ToolResultMessage[],
		context: ExtensionContext,
	): Promise<void> {
		this.#context = context;
		const active = this.#active;
		if (!active || message !== active.message) return;
		const sessionId = active.session.id;
		for (const result of toolResults) rememberImages(sessionId, result.content);
		active.completed = true;
		active.toolResults = toolResults;
	}

	async #completeActive(): Promise<void> {
		const active = this.#active;
		if (!active?.completed) return;
		this.#collectInputs();
		const inputs = this.#inputs();
		if (active.cancelled !== undefined) {
			const delivery: DeliveryRecord = {
				id: randomUUID(),
				chatId: active.request.chatId,
				sessionId: active.session.id,
				cwd: active.session.cwd,
				toolResults: active.toolResults,
				error: active.cancelled,
			};
			this.#deliveries.set(delivery.id, delivery);
			void this.#flushDeliveries().catch(() => {});
		} else {
			await this.#connection?.send({
				type: "result",
				id: active.request.id,
				cwd: active.session.cwd,
				message: active.message,
				inputs,
				...(active.request.type === "call"
					? { toolResults: active.toolResults }
					: {}),
			});
		}
		this.#active = undefined;
		this.#status = "idle";
		void this.#sync().catch(() => {});
	}

	#resetInputs(
		context?: ExtensionContext,
		cursor = context?.sessionManager.getLeafId() ?? null,
	): void {
		this.#sessionId = context?.sessionManager.getSessionId();
		this.#inputCursor = cursor;
		this.#pendingInputs.clear();
	}

	#collectInputs(): void {
		const context = this.#context;
		if (!context) return;
		const sessionManager = context.sessionManager;
		const sessionId = sessionManager.getSessionId();
		if (this.#sessionId !== sessionId) {
			this.#resetInputs(context);
			return;
		}
		const leafId = sessionManager.getLeafId();
		if (leafId === this.#inputCursor) return;
		const entries: SessionEntry[] = [];
		let current = sessionManager.getLeafEntry();
		while (current && current.id !== this.#inputCursor) {
			entries.push(current);
			current = current.parentId
				? sessionManager.getEntry(current.parentId)
				: undefined;
		}
		if (this.#inputCursor !== null && !current) {
			this.#resetInputs(context);
			return;
		}
		for (const entry of entries.reverse()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const message = entry.message as UserMessage;
			if (typeof message.content !== "string") {
				rememberImages(sessionId, message.content);
			}
			this.#pendingInputs.set(entry.id, { id: entry.id, sessionId, message });
		}
		this.#inputCursor = leafId;
	}

	#inputs(): SessionInput[] {
		this.#collectInputs();
		return [...this.#pendingInputs.values()];
	}

	async #flushDeliveries(): Promise<void> {
		const flushed = this.#flushing.then(async () => {
			const connection = this.#connection;
			if (!connection?.connected) return;
			for (const delivery of this.#deliveries.values()) {
				const completion = Promise.withResolvers<void>();
				this.#stores.set(delivery.id, completion);
				try {
					await connection.send({ type: "delivery", delivery });
					await completion.promise;
					this.#deliveries.delete(delivery.id);
					this.#notify(`Result saved for ChatGPT ${delivery.chatId.slice(-4)}`);
				} finally {
					this.#stores.delete(delivery.id);
				}
			}
		});
		this.#flushing = flushed.catch(() => {});
		return flushed;
	}

	async #reply(
		id: number,
		sessionId: string,
		response: () =>
			| Parameters<IpcClient["send"]>[0]
			| Promise<Parameters<IpcClient["send"]>[0]>,
	): Promise<void> {
		try {
			if (sessionId !== this.#context?.sessionManager.getSessionId()) {
				throw new Error("The requested Pi session is no longer active");
			}
			await this.#connection?.send(await response());
		} catch (error) {
			await this.#sendError(
				id,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	async #sendError(id: number, error: string): Promise<void> {
		await this.#connection?.send({ type: "result", id, error });
	}

	#rejectSyncs(error: Error): void {
		for (const sync of this.#syncs.values()) sync.reject(error);
		this.#syncs.clear();
	}

	#rejectStores(error: Error): void {
		for (const store of this.#stores.values()) store.reject(error);
		this.#stores.clear();
	}
}
