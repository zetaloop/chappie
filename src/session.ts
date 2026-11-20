import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { hostname } from "node:os";
import { type Activity, source, sourceLabel } from "./activity.ts";
import { Client } from "./client.ts";
import type { Config } from "./config.ts";
import { ConnectionIndicator } from "./connection.ts";
import type { DeliveryRecord } from "./delivery.ts";
import {
	copyFiles,
	type FileContext,
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
import type {
	BrokerMessage,
	ClientRequest,
	MessageInput,
	ModelRequest,
	SessionDescription,
	SessionInput,
	SessionResult,
} from "./ipc.ts";
import type { LaunchInput } from "./launch.ts";
import {
	type ResourceDescriptor,
	Resources,
	resourceSessionId,
} from "./resources.ts";
import type { ToolInput } from "./tools.ts";

type RemoteRequest = Extract<BrokerMessage, { type: "chat" | "exit" | "call" }>;

interface ActiveRequest {
	request: RemoteRequest;
	session: SessionDescription;
	message: AssistantMessage;
	completed: boolean;
	error?: string;
	cancelled: string | undefined;
	toolResults: ToolResultMessage[];
}

export class Session {
	readonly #host: Host;
	readonly #config: Config;
	readonly #syncs = new Map<number, PromiseWithResolvers<void>>();
	readonly #stores = new Map<string, PromiseWithResolvers<void>>();
	readonly #ready = new Set<PromiseWithResolvers<void>>();
	readonly #generations = new Map<
		string,
		{ output: Output; request: ModelRequest }
	>();
	readonly #queue: RemoteRequest[] = [];
	readonly #pendingInputs = new Map<string, SessionInput>();
	readonly #deliveries = new Map<string, DeliveryRecord>();
	readonly #requests = new Map<number, PromiseWithResolvers<SessionResult>>();
	readonly #operations = new Map<number, AbortController>();
	readonly #resources = new Resources();
	readonly #indicator?: ConnectionIndicator;
	readonly #receivedDeliveries: DeliveryRecord[] = [];
	#connection: Client | undefined;
	#output: Output | undefined;
	#active: ActiveRequest | undefined;
	#nextRequestId = 1;
	#starting = false;
	#sessionId: string | undefined;
	#flushing = Promise.resolve();
	#provider: boolean | undefined;
	#launchId = process.env.CHAPPIE_LAUNCH_ID;

	constructor(host: Host, config: Config = {}) {
		this.#host = host;
		if (host.status)
			this.#indicator = new ConnectionIndicator((label) =>
				host.status?.(label),
			);
		this.#config = config;
		delete process.env.CHAPPIE_LAUNCH_ID;
	}

	get localTools(): boolean {
		return Boolean(this.#config.localTools);
	}

	deliveries(): DeliveryRecord[] {
		return this.#receivedDeliveries.splice(0);
	}

	get id(): string {
		return this.#host.describe().id;
	}

	get connectionStatus() {
		return this.#indicator?.label;
	}

	#refreshStatus(): void {
		this.#indicator?.update(
			this.#connection?.status,
			this.#requests.size > 0,
			Boolean(this.#connection?.handling || this.#queue.length || this.#active),
		);
	}

	get #fileRecipient(): string | undefined {
		const request = this.#active?.request;
		return request?.type === "call" ? request.fileRecipient : undefined;
	}

	async sessions(signal?: AbortSignal) {
		const result = await this.#request({ type: "sessions" }, signal);
		if (!("sessions" in result))
			throw new Error("Broker returned no session list");
		return { self: this.id, ...result };
	}

	async launch(input: LaunchInput, signal?: AbortSignal) {
		const result = await this.#request({ type: "launch", ...input }, signal);
		if (!("session" in result))
			throw new Error("Broker returned no launched session");
		return result;
	}

	async tools(sessionId: string, names?: string[], signal?: AbortSignal) {
		const result = await this.#request(
			{
				type: "inspect",
				sessionId,
				environment: true,
				...(names ? { names } : {}),
			},
			signal,
		);
		if (!("inspection" in result))
			throw new Error("Session returned no tool catalog");
		return {
			...result.inspection,
			inputs: result.inputs,
			...(result.globalAgents ? { globalAgents: result.globalAgents } : {}),
		};
	}

	async resource(uri: string, signal?: AbortSignal) {
		signal?.throwIfAborted();
		const sessionId = resourceSessionId(uri);
		if (sessionId === this.id) return this.#resources.read(sessionId, uri);
		const result = await this.#request(
			{ type: "readResource", sessionId, uri },
			signal,
		);
		if (!("resource" in result))
			throw new Error("Session returned no resource");
		return result.resource;
	}

	async call(sessionId: string, calls: ToolInput[], signal?: AbortSignal) {
		const self = this.#host.describe();
		const fileRecipient = this.#fileRecipient;
		const result = await this.#request(
			{
				type: "call",
				sessionId,
				calls: calls.map((call) => ({
					...call,
					type: "toolCall",
					id: `chappie-${randomUUID()}`,
				})),
				...source(self.id, randomUUID(), self.name ?? self.agent),
				...(fileRecipient ? { fileRecipient } : {}),
			},
			signal,
		);
		if (!("toolResults" in result))
			throw new Error("Session returned no tool results");
		return { sessionId, ...result };
	}

	async message(
		sessionId: string,
		message: MessageInput,
		signal?: AbortSignal,
	) {
		const self = this.#host.describe();
		const result = await this.#request(
			{
				...message,
				sessionId,
				...source(self.id, randomUUID(), self.name ?? self.agent),
			},
			signal,
		);
		if (!("cwd" in result && "inputs" in result))
			throw new Error("Session returned no assistant message");
		return { sessionId, ...result };
	}

	async ready(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!this.#host.active())
			throw new Error("The requested session is no longer active");
		if (this.#generations.size || (this.#output && !this.#output.closed))
			return;
		const completion = Promise.withResolvers<void>();
		using _abort = addAbortListener(signal, () =>
			completion.reject(signal.reason),
		);
		this.#ready.add(completion);
		try {
			this.#wake();
			await completion.promise;
		} finally {
			this.#ready.delete(completion);
		}
	}

	async settled(error?: unknown): Promise<void> {
		const starting = this.#starting;
		this.#starting = false;
		const reason =
			error instanceof Error
				? error.message
				: error === undefined
					? "Session ended before the request completed"
					: String(error);
		if (error !== undefined || starting)
			this.#rejectReady(error ?? new Error(reason));
		const active = this.#active;
		if (active && !active.completed) {
			active.completed = true;
			active.error = reason;
		} else if (!active && starting) {
			const request = this.#queue.shift();
			if (request) await this.#sendError(request.id, reason);
			this.#refreshStatus();
		}
		this.#collectInputs();
		await this.#completeActive();
		await this.#dispatch();
	}

	#notify(
		message: string,
		type: "info" | "warning" | "error" = "info",
		activity: Activity = {},
	): void {
		this.#host.notify?.(message, type, activity);
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
		for (const pending of this.#ready) pending.resolve();
		try {
			await connection.connect();
			if (output.closed) return;
			this.#collectInputs();
			await this.#completeActive();
			if (output.closed) return;
			output.begin();
			await this.#dispatch();
			await output.finished;
		} finally {
			if (this.#output === output) this.#output = undefined;
		}
	}

	async generate(output: Output, request: ModelRequest): Promise<void> {
		const connection = this.#connection;
		if (!this.#host.active() || !connection)
			throw new Error("Chappie is not active for this session");
		if (output.closed) return;
		const id = randomUUID();
		this.#starting = false;
		this.#generations.set(id, { output, request });
		for (const pending of this.#ready) pending.resolve();
		try {
			await connection.connect();
			if (output.closed) return;
			await this.#completeActive();
			output.begin();
			await this.#sync();
			for (const queued of this.#queue.splice(0))
				await this.#cancelPending(queued);
			this.#refreshStatus();
			await output.finished;
		} finally {
			this.#generations.delete(id);
			void this.#sync().catch(() => {});
			await this.#dispatch();
		}
	}

	async transfer(
		args: TransferInput,
		signal?: AbortSignal,
		update?: (details: TransferDetails) => void,
	): Promise<TransferResult> {
		const context = {
			...this.#host.describe(),
			resources: this.#resources,
			...(this.#host.mutate ? { mutate: this.#host.mutate } : {}),
		};
		if ([args.files, args.from, args.to].filter(Boolean).length > 1)
			throw new Error("Use only one of files, from, or to");
		if (!args.files && !args.from && !args.to) {
			const fileRecipient = this.#fileRecipient;
			if (!fileRecipient)
				throw new Error(
					"Specify the transfer direction with files, from, or to",
				);
			update?.({
				device: context.device,
				files: [],
				resources: [],
				fileRecipient,
			});
			const result = await this.#export(args.paths, context, signal);
			return transferResult({ ...result.details, fileRecipient });
		}
		if (args.from) {
			const result = await this.#request(
				{
					type: "export",
					sessionId: args.from.sessionId,
					paths: args.from.paths,
				},
				signal,
			);
			if (!("transfer" in result))
				throw new Error("Session returned no resources");
			const copying = signal ?? new AbortController().signal;
			const files = await copyFiles(
				args.paths,
				result.transfer.resources,
				context.cwd,
				args.overwrite === true,
				(resource) => this.#readChunks(resource, copying),
				copying,
				context.mutate,
			);
			return transferResult({
				device: hostname(),
				files,
				resources: [],
				from: {
					sessionId: args.from.sessionId,
					device: result.transfer.device,
				},
			});
		}
		const { to } = args;
		if (!to) return transferFiles(args, context, signal, update);
		if (args.paths.length !== to.paths.length)
			throw new Error("Source and destination counts must match");
		const { sessions } = await this.sessions(signal);
		const destination = sessions.find(({ id }) => id === to.sessionId);
		if (!destination) throw new Error("Destination session is unavailable");
		const exported = await this.#export(args.paths, context, signal);
		update?.({
			...exported.details,
			to: {
				sessionId: to.sessionId,
				device: destination.device,
			},
		});
		const result = await this.#request(
			{
				type: "copy",
				sessionId: to.sessionId,
				paths: to.paths,
				resources: exported.details.resources,
				...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
			},
			signal,
		);
		if (!("transfer" in result))
			throw new Error("Session returned no transfer result");
		return transferResult({ ...result.transfer, device: hostname() });
	}

	async #export(
		paths: string[],
		context: FileContext,
		signal?: AbortSignal,
	): Promise<TransferResult> {
		const result = await transferFiles({ paths }, context, signal);
		this.#publish(result.details.resources);
		return result;
	}

	close(): void {
		const error = new Error("Chappie session ended");
		this.#leave(error);
		this.#connection?.close();
		this.#connection = undefined;
		this.#refreshStatus();
		this.resetInputs();
		this.#cancelRequests(error);
		this.#rejectSyncs(error);
		this.#rejectStores(error);
	}

	#leave(error: Error): void {
		const sessionId = this.#sessionId;
		if (this.#provider && sessionId && this.#connection?.connected) {
			void this.#connection
				.send({ type: "unregister", sessionId })
				.catch(() => {});
			if (this.#active)
				void this.#sendError(this.#active.request.id, error.message).catch(
					() => {},
				);
			for (const request of this.#queue)
				void this.#sendError(request.id, error.message).catch(() => {});
		}
		this.#output?.fail(error, true);
		for (const { output } of this.#generations.values())
			output.fail(error, true);
		this.#generations.clear();
		this.#output = undefined;
		this.#active = undefined;
		this.#queue.length = 0;
		this.#starting = false;
		this.#rejectReady(error);
	}

	update(): void {
		const active = this.#host.active();
		const id = this.#host.describe().id;
		if (this.#sessionId !== id) {
			if (this.#connection) this.close();
			else this.resetInputs();
		} else if (this.#provider !== active) {
			if (this.#provider) {
				if (this.#active && !this.#active.completed)
					void Promise.resolve(this.#host.abort()).catch((error: unknown) =>
						this.#notify(String(error), "error"),
					);
				this.#leave(new Error("Session switched away from Remote"));
				this.#refreshStatus();
			}
			this.resetInputs();
		}
		this.#provider = active;

		if (!this.#connection) {
			this.#connection = new Client(this.#config, {
				onOpen: async () => {
					this.#publish(this.#resources.list());
					await this.#sync();
					await this.#flushDeliveries();
				},
				onMessage: (message) => this.#receive(message),
				onClose: (error) => {
					this.#cancelRequests(error);
					this.#rejectReady(error);
					this.#rejectSyncs(error);
					this.#rejectStores(error);
					if (this.#output && !this.#output.closed) this.#output.fail(error);
					for (const { output } of this.#generations.values())
						output.fail(error);
					this.#active = undefined;
					this.#queue.length = 0;
					this.#starting = false;
				},
				onStatus: () => this.#refreshStatus(),
				onActivity: () => this.#refreshStatus(),
			});
			this.#connection.start();
		} else {
			void this.#sync().catch(() => {});
		}
	}

	#description(sessionId = this.#sessionId): SessionDescription {
		if (!this.#host.active() || sessionId !== this.#sessionId)
			throw new Error("The requested session is no longer active");
		const request = this.#active?.request;
		const activity: SessionDescription["activity"] = this.#generations.size
			? {
					type: "generation",
					kinds: [...this.#generations.values()].map(
						({ request }) => request.kind,
					),
				}
			: request?.type === "call"
				? { type: "call", tools: request.calls.map((call) => call.name) }
				: request
					? { type: "chat" }
					: undefined;
		return {
			...this.#host.describe(),
			...(activity ? { activity } : {}),
		};
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
			if (this.#launchId) {
				await connection.send({
					type: "launched",
					id: this.#launchId,
					sessionId: this.id,
				});
				this.#launchId = undefined;
			}
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
					const { type: _type, id: _id, deliveries, ...result } = message;
					this.#receivedDeliveries.push(...(deliveries ?? []));
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
				await this.#reply(message.id, async (signal) => {
					const tools = await this.#host.inspect(signal);
					const environment = message.environment
						? await this.#host.environment(signal)
						: undefined;
					const names = message.names;
					return {
						type: "result",
						id: message.id,
						inspection: {
							session: this.#description(message.sessionId),
							tools: names
								? tools.filter((tool) => names.includes(tool.name))
								: tools,
							...(environment ? { skills: environment.skills } : {}),
						},
						inputs: this.#inputs(),
						...(environment?.globalAgents
							? { globalAgents: environment.globalAgents }
							: {}),
					};
				});
				break;
			case "history":
				await this.#reply(message.id, async (signal) => {
					const { cwd } = this.#description(message.sessionId);
					return {
						type: "result",
						id: message.id,
						cwd,
						history: await this.#host.history(signal),
					};
				});
				break;
			case "inputs":
				await this.#reply(message.id, () => {
					this.#description(message.sessionId);
					return {
						type: "result",
						id: message.id,
						inputs: this.#inputs(),
					};
				});
				break;
			case "ackInputs":
				if (message.sessionId === this.#sessionId) {
					for (const id of message.ids) this.#pendingInputs.delete(id);
				}
				break;
			case "readResource":
				await this.#reply(message.id, async () => ({
					type: "result",
					id: message.id,
					resource: await this.#resources.read(
						message.sessionId,
						message.uri,
						message.offset,
					),
				}));
				break;
			case "export":
				await this.#reply(message.id, async (signal) => {
					const result = await this.#export(
						message.paths,
						{
							...this.#description(message.sessionId),
							resources: this.#resources,
						},
						signal,
					);
					return { type: "result", id: message.id, transfer: result.details };
				});
				break;
			case "copy": {
				await this.#reply(message.id, async (signal) => {
					const context = this.#description(message.sessionId);
					const files = await copyFiles(
						message.paths,
						message.resources,
						context.cwd,
						message.overwrite === true,
						(resource) => this.#readChunks(resource, signal),
						signal,
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
				});
				break;
			}
			case "cancel": {
				const operation = this.#operations.get(message.id);
				if (operation) {
					operation.abort(new Error(message.reason));
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
						: request.type;
				this.#notify(
					`${name} cancelled for ${sourceLabel(request)}: ${message.reason}`,
					"warning",
					{
						event: "cancelled",
						...source(request.clientId, request.requestId, request.label),
					},
				);
				if (queued !== -1) {
					this.#queue.splice(queued, 1);
					this.#refreshStatus();
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
			case "exit":
			case "call":
				if (!this.#host.active() || message.sessionId !== this.#sessionId) {
					await this.#sendError(
						message.id,
						"The requested session is no longer active",
					);
					break;
				}
				if (message.type === "chat" && message.replyTo) {
					const generation = this.#generations.get(message.replyTo);
					if (!generation || generation.output.closed) {
						await this.#sendError(message.id, "The model request has ended");
						break;
					}
					const output = generation.output;
					output.message.chappie = source(
						message.clientId,
						message.requestId,
						message.label,
					);
					output.text(message.text);
					output.done();
					this.#generations.delete(message.replyTo);
					await this.#connection?.send({
						type: "result",
						id: message.id,
						cwd: this.#host.describe().cwd,
						inputs: this.#inputs(),
					});
					break;
				}
				if (this.#generations.size) {
					await this.#cancelPending(message);
					break;
				}
				this.#queue.push(message);
				await this.#dispatch();
				break;
		}
	}

	async #cancelPending(request: RemoteRequest): Promise<void> {
		await this.#connection?.send({
			type: "result",
			id: request.id,
			cwd: this.#host.describe().cwd,
			cancelled:
				request.type === "call"
					? "The requested tools were not executed. A model request is awaiting a reply."
					: "A model request is awaiting a reply. Answer it using its request ID.",
			toolResults: [],
			inputs: this.#inputs(),
		});
	}

	#publish(resources: ResourceDescriptor[]): void {
		if (!resources.length) return;
		if (this.#connection?.connected) {
			void this.#connection
				.send({ type: "resources", resources })
				.catch(() => {});
		}
	}

	async #request(
		request: ClientRequest,
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
		this.#refreshStatus();
		signal?.addEventListener("abort", onAbort, { once: true });
		void connection
			.send({ type: "request", id, clientId: this.id, request })
			.catch(completion.reject);
		try {
			return await completion.promise;
		} finally {
			this.#requests.delete(id);
			this.#refreshStatus();
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
		for (const controller of this.#operations.values()) controller.abort(error);
		this.#operations.clear();
	}

	async #dispatch(): Promise<void> {
		while (!this.#active && !this.#generations.size) {
			const output = this.#output;
			if (!output || output.closed) {
				this.#wake();
				return;
			}

			const request = this.#queue.shift();
			if (!request) return;
			output.message.chappie = source(
				request.clientId,
				request.requestId,
				request.label,
			);
			if (request.type === "chat") {
				output.text(request.text, "commentary");
				await this.#connection?.send({
					type: "result",
					id: request.id,
					cwd: this.#host.describe().cwd,
					inputs: this.#inputs(),
				});
				continue;
			}
			this.#active = {
				request,
				session: this.#description(),
				message: output.message,
				completed: false,
				cancelled: undefined,
				toolResults: [],
			};
			void this.#sync().catch(() => {});
			if (request.type === "exit") {
				output.text(request.text, "final_answer");
				output.done();
			} else {
				output.toolCalls(request.calls);
				output.done("toolUse");
			}
			return;
		}
	}

	#wake(): void {
		if (
			this.#starting ||
			this.#generations.size ||
			this.#output ||
			this.#active ||
			(this.#queue.length === 0 && this.#ready.size === 0) ||
			!this.#host.isIdle()
		)
			return;
		this.#starting = true;
		void Promise.resolve()
			.then(() => {
				if (this.#starting && this.#host.active()) return this.#host.wake();
			})
			.catch(async (error: unknown) => {
				this.#starting = false;
				this.#rejectReady(error);
				const request = this.#queue.shift();
				if (request)
					await this.#sendError(
						request.id,
						error instanceof Error ? error.message : String(error),
					);
				this.#refreshStatus();
			});
	}

	complete(
		message: unknown,
		toolResults: ToolResultMessage[],
		error?: string,
	): void {
		const active = this.#active;
		const completed = message as Partial<AssistantMessage> | undefined;
		const origin = completed?.chappie;
		const failure = error ?? completed?.errorMessage;
		if (
			!active ||
			(failure === undefined &&
				message !== active.message &&
				(!origin ||
					origin.clientId !== active.request.clientId ||
					origin.requestId !== active.request.requestId))
		)
			return;
		const sessionId = active.session.id;
		for (const result of toolResults)
			this.#publish(this.#resources.rememberImages(sessionId, result.content));
		if (failure !== undefined) active.error = failure;
		active.toolResults = toolResults;
		if (active.request.type === "call") {
			const results = new Map(
				toolResults.map((result) => [result.toolCallId, result]),
			);
			active.toolResults = active.request.calls.flatMap(
				(call) => results.get(call.id) ?? [],
			);
			const missing = active.request.calls.flatMap((call, index) =>
				results.has(call.id) ? [] : [`${index + 1} (${call.name})`],
			);
			if (missing.length)
				active.error ??= `No results for calls ${missing.join(", ")}`;
		}
		active.completed = true;
	}

	async #completeActive(): Promise<void> {
		const active = this.#active;
		if (!active?.completed) return;
		this.#collectInputs();
		const inputs = this.#inputs();
		if (active.cancelled !== undefined) {
			const delivery: DeliveryRecord = {
				id: randomUUID(),
				...source(
					active.request.clientId,
					active.request.requestId,
					active.request.label,
				),
				sessionId: active.session.id,
				cwd: active.session.cwd,
				toolResults: active.toolResults,
				error: active.cancelled,
			};
			this.#deliveries.set(delivery.id, delivery);
			void this.#flushDeliveries().catch(() => {});
		} else if (active.error !== undefined) {
			await this.#sendError(active.request.id, active.error);
		} else {
			await this.#connection?.send({
				type: "result",
				id: active.request.id,
				cwd: active.session.cwd,
				inputs,
				...(active.request.type === "call"
					? { toolResults: active.toolResults }
					: {}),
			});
		}
		this.#active = undefined;
		this.#refreshStatus();
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
			if ("message" in input && typeof input.message.content !== "string")
				this.#publish(
					this.#resources.rememberImages(
						input.sessionId,
						input.message.content,
					),
				);
			this.#pendingInputs.set(input.id, input);
		}
	}

	#inputs(): SessionInput[] {
		this.#collectInputs();
		const generation = this.#generations.entries().next().value;
		return [
			...(generation
				? [
						{
							id: generation[0],
							sessionId: this.id,
							request: generation[1].request,
						},
					]
				: []),
			...this.#pendingInputs.values(),
		];
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
					this.#notify(`Result saved for ${sourceLabel(delivery)}`, "info", {
						event: "result_saved",
						...source(delivery.clientId, delivery.requestId, delivery.label),
					});
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
		response: (
			signal: AbortSignal,
		) => Parameters<Client["send"]>[0] | Promise<Parameters<Client["send"]>[0]>,
	): Promise<void> {
		const controller = new AbortController();
		this.#operations.set(id, controller);
		try {
			await this.#connection?.send(await response(controller.signal));
		} catch (error) {
			await this.#sendError(
				id,
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			this.#operations.delete(id);
		}
	}

	#rejectReady(error: unknown): void {
		for (const pending of this.#ready) pending.reject(error);
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
