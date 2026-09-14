import { randomUUID } from "node:crypto";
import type {
	AssistantMessage,
	Context,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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

type RemoteRequest = Extract<BrokerMessage, { type: "chat" | "call" }>;

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
	message: AssistantMessage;
	completed: boolean;
	cancelled: boolean;
	toolResults: ToolResultMessage[];
}

export class LocalSession {
	readonly #pi: ExtensionAPI;
	readonly #agentDir: string;
	readonly #syncs = new Map<number, SyncRequest>();
	readonly #stores = new Map<string, StoreRequest>();
	readonly #queue: RemoteRequest[] = [];
	readonly #seenInputs = new Set<string>();
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
	#flushing = Promise.resolve();

	constructor(pi: ExtensionAPI, agentDir: string) {
		this.#pi = pi;
		this.#agentDir = agentDir;
	}

	install(): void {
		this.#pi.on("session_start", (_event, context) => this.#update(context));
		this.#pi.on("model_select", (event, context) =>
			this.#update(context, event.model.provider === "chappi"),
		);
		this.#pi.on("session_info_changed", (_event, context) => {
			this.#context = context;
			void this.#sync().catch(() => {});
		});
		this.#pi.on("context", (event) => ({
			messages: event.messages.filter(
				(message) =>
					message.role !== "custom" || message.customType !== "chappi.request",
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

	async start(
		output: ProviderOutput,
		_providerContext: Context,
	): Promise<void> {
		const context = this.#context;
		const connection = this.#connection;
		if (context?.model?.provider !== "chappi" || !connection) {
			throw new Error("Chappi is not active for this session");
		}
		if (this.#output && !this.#output.closed) {
			throw new Error("Chappi already has an active provider request");
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
		this.#output?.fail(new Error("Chappi session ended"), true);
		this.#output = undefined;
		this.#active = undefined;
		this.#queue.length = 0;
		this.#starting = false;
		this.#connection?.close();
		this.#connection = undefined;
		this.#context = undefined;
		this.#rejectSyncs(new Error("Chappi session ended"));
		this.#rejectStores(new Error("Chappi session ended"));
	}

	#update(
		context: ExtensionContext,
		active = context.model?.provider === "chappi",
	): void {
		this.#context = context;
		if (!active) {
			this.close();
			return;
		}
		if (!this.#connection) {
			this.#connection = new IpcClient(this.#agentDir, {
				onOpen: async () => {
					await this.#sync();
					await this.#flushDeliveries();
				},
				onMessage: (message) => this.#receive(message),
				onClose: (error) => {
					this.#rejectSyncs(error);
					this.#rejectStores(error);
					this.#output?.fail(error);
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
		if (!context) throw new Error("Chappi session is not available");
		const name = this.#pi.getSessionName();
		const sessionFile = context.sessionManager.getSessionFile();
		return {
			id: context.sessionManager.getSessionId(),
			cwd: context.cwd,
			status: this.#status,
			...(name ? { name } : {}),
			...(sessionFile ? { sessionFile } : {}),
		};
	}

	async #sync(): Promise<void> {
		const connection = this.#connection;
		if (
			!connection?.connected ||
			!this.#context ||
			this.#context.model?.provider !== "chappi"
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
			case "inspect":
				await this.#reply(message.id, message.sessionId, () => ({
					type: "result",
					id: message.id,
					inspection: this.#inspection(),
					inputs: this.#inputs(),
				}));
				break;
			case "ackInputs":
				if (
					message.sessionId === this.#context?.sessionManager.getSessionId()
				) {
					for (const id of message.ids) this.#pendingInputs.delete(id);
				}
				break;
			case "cancel": {
				const queued = this.#queue.findIndex(
					(request) => request.id === message.id,
				);
				if (queued !== -1) {
					this.#queue.splice(queued, 1);
					break;
				}
				if (this.#active?.request.id !== message.id) break;
				this.#active.cancelled = true;
				if (this.#active.completed) await this.#completeActive();
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
			message: output.message,
			completed: false,
			cancelled: false,
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
				customType: "chappi.request",
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
		active.completed = true;
		active.toolResults = toolResults;
	}

	async #completeActive(): Promise<void> {
		const active = this.#active;
		if (!active?.completed) return;
		this.#collectInputs();
		const inputs = this.#inputs();
		if (active.cancelled) {
			const context = this.#context;
			if (context) {
				const sessionFile = context.sessionManager.getSessionFile();
				const delivery: DeliveryRecord = {
					id: randomUUID(),
					chatId: active.request.chatId,
					sessionId: context.sessionManager.getSessionId(),
					toolCallIds:
						active.request.type === "call"
							? active.request.calls.map(({ id }) => id)
							: [],
					...(sessionFile
						? { sessionFile }
						: { inlineResults: active.toolResults }),
					...(active.message.errorMessage
						? { error: active.message.errorMessage }
						: { error: "Request cancelled" }),
				};
				this.#deliveries.set(delivery.id, delivery);
				await this.#flushDeliveries().catch(() => {});
			}
		} else {
			await this.#connection?.send(
				active.request.type === "call"
					? {
							type: "result",
							id: active.request.id,
							message: active.message,
							toolResults: active.toolResults,
							inputs,
						}
					: {
							type: "result",
							id: active.request.id,
							message: active.message,
							inputs,
						},
			);
		}
		this.#active = undefined;
		this.#status = "idle";
		void this.#sync().catch(() => {});
	}

	#collectInputs(): void {
		const context = this.#context;
		if (!context) return;
		const sessionId = context.sessionManager.getSessionId();
		if (this.#sessionId !== sessionId) {
			this.#sessionId = sessionId;
			this.#seenInputs.clear();
			this.#pendingInputs.clear();
		}
		for (const entry of context.sessionManager.getBranch()) {
			if (
				entry.type !== "message" ||
				entry.message.role !== "user" ||
				this.#seenInputs.has(entry.id)
			)
				continue;
			this.#seenInputs.add(entry.id);
			this.#pendingInputs.set(entry.id, {
				id: entry.id,
				message: entry.message as UserMessage,
			});
		}
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
		response: () => Parameters<IpcClient["send"]>[0],
	): Promise<void> {
		try {
			if (sessionId !== this.#context?.sessionManager.getSessionId()) {
				throw new Error("The requested Pi session is no longer active");
			}
			await this.#connection?.send(response());
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
