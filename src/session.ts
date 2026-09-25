import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { type Activity, chatLabel, source } from "./activity.ts";
import { getDirectory } from "./config.ts";
import type { DeliveryRecord } from "./delivery.ts";
import {
	copyFiles,
	type TransferDetails,
	type TransferInput,
	type TransferResult,
	transferFiles,
	transferResult,
} from "./files.ts";
import type {
	AssistantMessage,
	Host,
	Output,
	ToolResultMessage,
} from "./host.ts";
import {
	type BrokerMessage,
	IpcClient,
	type SessionDescription,
	type SessionInput,
	type SessionRequest,
	type SessionResult,
	type SessionStatus,
} from "./ipc.ts";
import {
	type ResourceDescriptor,
	readSessionResource,
	rememberImages,
	resourceSessionId,
} from "./resources.ts";

type RemoteRequest = Extract<BrokerMessage, { type: "chat" | "call" }>;

interface SyncRequest {
	resolve(): void;
	reject(error: Error): void;
}

interface StoreRequest {
	resolve(): void;
	reject(error: Error): void;
}

interface PendingRequest {
	resolve(result: SessionResult): void;
	reject(error: Error): void;
}

interface HistoryRequest {
	request: Extract<BrokerMessage, { type: "history" }>;
	timeout: NodeJS.Timeout;
}

interface ActiveRequest {
	request: RemoteRequest;
	session: SessionDescription;
	message: AssistantMessage;
	completed: boolean;
	cancelled: string | undefined;
	toolResults: ToolResultMessage[];
}

export class Session {
	readonly #host: Host;
	readonly #connect: string | undefined;
	readonly #syncs = new Map<number, SyncRequest>();
	readonly #stores = new Map<string, StoreRequest>();
	readonly #queue: RemoteRequest[] = [];
	readonly #pendingInputs = new Map<string, SessionInput>();
	readonly #deliveries = new Map<string, DeliveryRecord>();
	readonly #histories = new Map<number, HistoryRequest>();
	readonly #requests = new Map<number, PendingRequest>();
	readonly #copies = new Map<number, AbortController>();
	#connection: IpcClient | undefined;
	#output: Output | undefined;
	#active: ActiveRequest | undefined;
	#status: SessionStatus = "idle";
	#nextRequestId = 1;
	#starting = false;
	#sessionId: string | undefined;
	#flushing = Promise.resolve();

	constructor(host: Host, connect?: string) {
		this.#host = host;
		this.#connect = connect;
	}

	async settled(): Promise<void> {
		this.#starting = false;
		this.#collectInputs();
		this.historyChanged();
		await this.#completeActive();
		this.#dispatch();
	}

	#notify(
		message: string,
		type: "info" | "warning" | "error" = "info",
		activity: Activity = {},
	): void {
		this.#host.notify?.(message, type, activity);
		if (activity.event !== "history") this.historyChanged();
	}

	async start(output: Output): Promise<void> {
		const connection = this.#connection;
		if (!this.#host.active() || !connection) {
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
			this.historyChanged();
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

	async transfer(
		args: TransferInput,
		signal?: AbortSignal,
		update?: (details: TransferDetails) => void,
	): Promise<TransferResult> {
		const context = {
			...this.#host.describe(),
			...(this.#host.mutate ? { mutate: this.#host.mutate } : {}),
		};
		if (!args.to) return transferFiles(args, context, signal, update);
		if (args.files) throw new Error("files and to are mutually exclusive");
		if (args.paths.length !== args.to.paths.length)
			throw new Error("Source and destination counts must match");
		const inspected = await this.#request(
			{ type: "inspect", sessionId: args.to.sessionId },
			signal,
		);
		if (!("inspection" in inspected))
			throw new Error("Session returned no environment");
		const exported = await transferFiles(
			{ paths: args.paths },
			context,
			signal,
		);
		update?.({
			...exported.details,
			to: {
				sessionId: args.to.sessionId,
				device: inspected.inspection.session.device,
			},
		});
		const result = await this.#request(
			{
				type: "copy",
				sessionId: args.to.sessionId,
				paths: args.to.paths,
				resources: exported.details.resources,
				...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
			},
			signal,
		);
		if (!("transfer" in result))
			throw new Error("Session returned no transfer result");
		return transferResult({ ...result.transfer, device: hostname() });
	}

	close(): void {
		const sessionId = this.#sessionId;
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
		this.resetInputs();
		this.#cancelRequests(new Error("Chappie session ended"));
		this.#rejectSyncs(new Error("Chappie session ended"));
		this.#rejectStores(new Error("Chappie session ended"));
		for (const id of this.#histories.keys()) this.#finishHistory(id);
	}

	update(): void {
		if (!this.#host.active()) {
			this.close();
			return;
		}
		if (this.#sessionId !== this.#host.describe().id) {
			if (this.#sessionId && this.#connection?.connected) {
				void this.#connection
					.send({ type: "unregister", sessionId: this.#sessionId })
					.catch(() => {});
			}
			this.resetInputs();
		}

		if (!this.#connection) {
			this.#connection = new IpcClient(getDirectory(), this.#connect, {
				onOpen: async () => {
					await this.#sync();
					await this.#flushDeliveries();
				},
				onMessage: (message) => this.#receive(message),
				onClose: (error) => {
					this.#cancelRequests(error);
					for (const id of this.#histories.keys()) this.#finishHistory(id);
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
		return { ...this.#host.describe(), status: this.#status };
	}

	async #sync(): Promise<void> {
		const connection = this.#connection;
		if (!connection?.connected || !this.#host.active()) return;
		const id = this.#nextRequestId++;
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
			case "response": {
				const pending = this.#requests.get(message.id);
				if (!pending) break;
				if ("error" in message) pending.reject(new Error(message.error));
				else {
					const { type: _type, id: _id, ...result } = message;
					pending.resolve(result);
				}
				break;
			}
			case "synced":
				this.#syncs.get(message.id)?.resolve();
				break;
			case "stored":
				this.#stores.get(message.id)?.resolve();
				break;
			case "notice":
				if (message.sessionId === this.#sessionId) {
					this.#notify(message.message, "info", message.activity);
				}
				break;
			case "inspect":
				await this.#reply(message.id, message.sessionId, async () => {
					const { globalAgents, ...environment } = await this.#host.inspect();
					return {
						type: "result",
						id: message.id,
						inspection: { session: this.#description(), ...environment },
						inputs: this.#inputs(),
						...(globalAgents ? { globalAgents } : {}),
					};
				});
				break;
			case "history":
				await this.#readHistory(message);
				break;
			case "ackInputs":
				if (message.sessionId === this.#sessionId) {
					for (const id of message.ids) this.#pendingInputs.delete(id);
				}
				break;
			case "readResource":
				await this.#reply(message.id, message.sessionId, async () => ({
					type: "result",
					id: message.id,
					resource: await readSessionResource(
						message.sessionId,
						message.uri,
						message.offset,
					),
				}));
				break;
			case "copy": {
				const controller = new AbortController();
				this.#copies.set(message.id, controller);
				void this.#reply(message.id, message.sessionId, async () => {
					const context = this.#host.describe();
					const files = await copyFiles(
						message.paths,
						message.resources,
						context.cwd,
						message.overwrite === true,
						(resource) => this.#readChunks(resource, controller.signal),
						controller.signal,
						this.#host.mutate,
					);
					return {
						type: "result",
						id: message.id,
						transfer: {
							device: hostname(),
							files,
							resources: [],
							to: { sessionId: message.sessionId, device: hostname() },
						},
					};
				})
					.finally(() => this.#copies.delete(message.id))
					.catch(() => {});
				break;
			}
			case "cancel": {
				const copying = this.#copies.get(message.id);
				if (copying) {
					copying.abort(new Error(message.reason));
					break;
				}
				if (this.#histories.has(message.id)) {
					this.#finishHistory(message.id);
					break;
				}
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
					`${name} cancelled for ${chatLabel(request)}: ${message.reason}`,
					"warning",
					{
						event: "cancelled",
						...source(request.chatId, request.requestId),
					},
				);
				if (queued !== -1) {
					this.#queue.splice(queued, 1);
					break;
				}
				const active = this.#active;
				if (!active) break;
				active.cancelled = message.reason;
				if (active.completed) await this.#completeActive();
				else await this.#host.abort();
				break;
			}
			case "chat":
			case "call":
				if (message.sessionId !== this.#sessionId) {
					await this.#sendError(
						message.id,
						"The requested session is no longer active",
					);
					break;
				}
				this.#queue.push(message);
				this.#dispatch();
				break;
		}
	}

	async #request(
		request: SessionRequest,
		signal?: AbortSignal,
	): Promise<SessionResult> {
		signal?.throwIfAborted();
		const connection = this.#connection;
		if (!connection?.connected) throw new Error("Chappie is not connected");
		const id = this.#nextRequestId++;
		const completion = Promise.withResolvers<SessionResult>();
		const onAbort = (): void => {
			completion.reject(signal?.reason);
			void connection.send({ type: "cancelRequest", id }).catch(() => {});
		};
		this.#requests.set(id, completion);
		signal?.addEventListener("abort", onAbort, { once: true });
		void connection
			.send({ type: "request", id, request })
			.catch(completion.reject);
		try {
			return await completion.promise;
		} finally {
			this.#requests.delete(id);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async *#readChunks(
		resource: ResourceDescriptor,
		signal: AbortSignal,
	): AsyncGenerator<Uint8Array> {
		for (let offset = 0; offset < resource.size; ) {
			const result = await this.#request(
				{
					type: "readResource",
					sessionId: resourceSessionId(resource.uri),
					uri: resource.uri,
					offset,
				},
				signal,
			);
			if (!("resource" in result))
				throw new Error("Session returned no resource");
			const data = Buffer.from(result.resource.blob, "base64");
			if (data.length === 0)
				throw new Error(
					`Source ended before ${resource.size} bytes: ${resource.name}`,
				);
			yield data;
			offset += data.length;
		}
	}

	#cancelRequests(error: Error): void {
		for (const pending of this.#requests.values()) pending.reject(error);
		this.#requests.clear();
		for (const controller of this.#copies.values()) controller.abort(error);
		this.#copies.clear();
	}

	async #readHistory(
		request: HistoryRequest["request"],
		wait = request.range.wait,
	): Promise<void> {
		try {
			const context = this.#host.describe();
			if (context.id !== request.sessionId)
				throw new Error("The requested session is no longer active");
			const history = await this.#host.history(request.range);
			if (wait && !request.range.before && history.count === 0) {
				if (!this.#histories.has(request.id)) {
					this.#histories.set(request.id, {
						request,
						timeout: setTimeout(() => {
							void this.#readHistory(request, false).catch(() => {});
						}, 30_000),
					});
				}
				return;
			}
			this.#finishHistory(request.id);
			if (!request.range.observer) {
				this.#notify(
					`${chatLabel(request)} read history: ${history.count} entries`,
					"info",
					{ event: "history", ...source(request.chatId, request.requestId) },
				);
			}
			await this.#connection?.send({
				type: "result",
				id: request.id,
				cwd: context.cwd,
				history,
			});
		} catch (error) {
			this.#finishHistory(request.id);
			await this.#sendError(
				request.id,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	historyChanged(): void {
		for (const { request } of this.#histories.values()) {
			void this.#readHistory(request).catch(() => {});
		}
	}

	#finishHistory(id: number): void {
		const pending = this.#histories.get(id);
		if (!pending) return;
		clearTimeout(pending.timeout);
		this.#histories.delete(id);
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
		output.message.chappie = source(request.chatId, request.requestId);
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
			!this.#host.isIdle()
		)
			return;
		this.#starting = true;
		void Promise.resolve()
			.then(() => this.#host.wake())
			.catch((error: unknown) => {
				this.#starting = false;
				const request = this.#queue.shift();
				if (request)
					return this.#sendError(
						request.id,
						error instanceof Error ? error.message : String(error),
					);
			});
	}

	complete(message: unknown, toolResults: ToolResultMessage[]): void {
		this.historyChanged();
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
				...source(active.request.chatId, active.request.requestId),
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

	resetInputs(): void {
		this.#sessionId = this.#host.describe().id;
		this.#pendingInputs.clear();
		this.#host.resetInputs();
	}

	#collectInputs(): void {
		if (!this.#host.active()) return;
		for (const input of this.#host.inputs()) {
			if (typeof input.message.content !== "string")
				rememberImages(input.sessionId, input.message.content);
			this.#pendingInputs.set(input.id, input);
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
					this.#notify(
						`Result saved for ChatGPT ${delivery.chatId.slice(-4)}`,
						"info",
						{
							event: "result_saved",
							...source(delivery.chatId, delivery.requestId),
						},
					);
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
			if (sessionId !== this.#sessionId) {
				throw new Error("The requested session is no longer active");
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
