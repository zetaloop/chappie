import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { mkdir } from "node:fs/promises";
import { type Activity, source, sourceLabel } from "./activity.ts";
import type { DeviceDescription } from "./client.ts";
import { readConfig } from "./config.ts";
import type { DeliveryRecord } from "./delivery.ts";
import type { ToolCall, ToolResultMessage } from "./host.ts";
import {
	type BrokerMessage,
	type ClientRequest,
	IpcServer,
	type JsonLinePeer,
	type SessionDescription,
	type SessionInput,
	type SessionInspection,
	type SessionMessage,
	type SessionResult,
} from "./ipc.ts";
import type { LaunchInput } from "./launch.ts";
import { type ResourceData, resourceSessionId } from "./resources.ts";
import { State } from "./state.ts";
import type { ToolInput } from "./tools.ts";

interface RegisteredSession {
	description: SessionDescription;
	peer: JsonLinePeer<SessionMessage, BrokerMessage>;
}

interface PendingRequest {
	peer: JsonLinePeer<SessionMessage, BrokerMessage>;
	resolve(result: SessionResult): void;
	reject(error: Error): void;
	signal: AbortSignal;
	onAbort(): void;
}

interface ChangeWaiter {
	resolve(): void;
	reject(error: Error): void;
	signal: AbortSignal;
	onAbort(): void;
}

interface PendingLaunch {
	peer: JsonLinePeer<SessionMessage, BrokerMessage>;
	worker?: JsonLinePeer<SessionMessage, BrokerMessage>;
	device: string;
	sessionId?: string;
	resolve(sessionId: string): void;
	reject(error: Error): void;
}

export interface InitializedSession extends Omit<SessionInspection, "tools"> {
	selection: "existing" | "explicit";
	globalAgents?: { path: string };
	inputs: SessionInput[];
	tools: { name: string; description: string }[];
}

export interface InspectedSession extends SessionInspection {
	inputs: SessionInput[];
}

export interface ChatResult {
	cancelled?: string;
	sessionId: string;
	cwd: string;
	inputs: SessionInput[];
}

export interface CallResult extends ChatResult {
	toolResults: ToolResultMessage[];
}

export class Broker {
	readonly #directory: string;
	readonly #ipc: IpcServer;
	readonly #state: State;
	readonly #sessions = new Map<string, RegisteredSession>();
	readonly #clients = new Map<
		JsonLinePeer<SessionMessage, BrokerMessage>,
		DeviceDescription
	>();
	readonly #launches = new Map<string, PendingLaunch>();
	readonly #resources = new Map<
		string,
		JsonLinePeer<SessionMessage, BrokerMessage>
	>();
	readonly #pending = new Map<number, PendingRequest>();
	readonly #waiters = new Set<ChangeWaiter>();
	readonly #relays = new Map<
		JsonLinePeer<SessionMessage, BrokerMessage>,
		Map<number, AbortController>
	>();
	#nextRequestId = 1;

	constructor(directory: string) {
		this.#directory = directory;
		this.#state = new State(directory);
		this.#ipc = new IpcServer(
			directory,
			(peer, message) => this.#receive(peer, message),
			(peer) => this.#removePeer(peer),
		);
	}

	async start(): Promise<void> {
		const config = await readConfig(this.#directory);
		await mkdir(this.#directory, { recursive: true });
		await this.#state.load();
		await this.#ipc.start(config.listen ?? false);
	}

	async close(): Promise<void> {
		const error = new Error("Chappie broker ended");
		for (const launch of this.#launches.values()) launch.reject(error);
		this.#launches.clear();
		this.#clients.clear();
		for (const relays of this.#relays.values()) {
			for (const controller of relays.values()) controller.abort(error);
		}
		this.#relays.clear();
		for (const [id, pending] of this.#pending) {
			this.#finishRequest(id, pending);
			pending.reject(error);
		}
		for (const waiter of this.#waiters) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(error);
		}
		this.#waiters.clear();
		this.#sessions.clear();
		this.#resources.clear();
		await this.#ipc.close();
	}

	listSessions(sessionId?: string): (SessionDescription & {
		bindingCount: number;
	})[] {
		const counts = this.#state.bindingCounts();
		return [...this.#sessions.values()]
			.filter(({ description }) => !sessionId || description.id === sessionId)
			.map(({ description }) => ({
				...description,
				bindingCount: counts.get(description.id) ?? 0,
			}));
	}

	binding(chatId: string): string | undefined {
		return this.#state.binding(chatId);
	}

	listDevices(): DeviceDescription[] {
		return [
			...new Map(
				[...this.#clients.values()].map((device) => [device.id, device]),
			).values(),
		];
	}

	async launch(input: LaunchInput, signal: AbortSignal) {
		signal.throwIfAborted();
		const connection = [...this.#clients].find(
			([, device]) => device.id === input.device,
		);
		if (!connection) throw new Error(`Device ${input.device} is offline`);
		const [peer] = connection;
		const id = randomUUID();
		const completion = Promise.withResolvers<string>();
		this.#launches.set(id, {
			peer,
			device: input.device,
			resolve: completion.resolve,
			reject: completion.reject,
		});
		using _abort = addAbortListener(signal, () =>
			completion.reject(abortError(signal)),
		);
		try {
			void peer
				.send({ type: "launch", id, agent: input.agent, cwd: input.cwd })
				.catch(completion.reject);
			const sessionId = await completion.promise;
			signal.throwIfAborted();
			const session = this.#sessions.get(sessionId);
			if (!session) throw new Error(`Session ${sessionId} is offline`);
			return { session: session.description };
		} finally {
			const launch = this.#launches.get(id);
			this.#launches.delete(id);
			await launch?.worker?.send({ type: "launchDone", id }).catch(() => {});
		}
	}

	async initialize(
		chatId: string,
		sessionId: string | undefined,
		requestId: unknown,
		signal: AbortSignal,
	): Promise<InitializedSession> {
		const { sessionId: target, selection } = await this.#selectSession(
			chatId,
			sessionId,
			signal,
		);
		await this.#join(chatId, target, requestId, signal);
		const { inspection, inputs, globalAgents } = await this.#inspect(
			target,
			signal,
		);
		await this.#ackInputs(target, inputs, signal);
		return {
			selection,
			...inspection,
			tools: inspection.tools.map(({ name, description }) => ({
				name,
				description: description.split("\n", 1)[0] ?? description,
			})),
			inputs,
			...(globalAgents ? { globalAgents } : {}),
		};
	}

	async chat(
		chatId: string,
		sessionId: string | undefined,
		text: string,
		requestId: unknown,
		signal: AbortSignal,
		replyTo?: string,
	): Promise<ChatResult> {
		const { sessionId: target } = await this.#selectSession(
			chatId,
			sessionId,
			signal,
		);
		const result = await this.#request(
			target,
			(id) => ({
				type: "chat",
				id,
				...source(chatId, requestId),
				sessionId: target,
				text,
				...(replyTo ? { replyTo } : {}),
			}),
			signal,
		);
		if ("message" in result || "cancelled" in result) {
			const inputs = result.inputs;
			await this.#ackInputs(target, inputs, signal);
			return {
				sessionId: target,
				cwd: result.cwd,
				inputs,
				...("cancelled" in result ? { cancelled: result.cancelled } : {}),
			};
		}
		throw new Error("Session returned no assistant message");
	}

	async tools(
		chatId: string,
		sessionId: string | undefined,
		names: string[] | undefined,
		signal: AbortSignal,
	): Promise<InspectedSession> {
		const { sessionId: target } = await this.#selectSession(
			chatId,
			sessionId,
			signal,
		);
		const { inspection, inputs } = await this.#inspect(target, signal);
		await this.#ackInputs(target, inputs, signal);
		const selected = names ? new Set(names) : undefined;
		return {
			...inspection,
			tools: selected
				? inspection.tools.filter(({ name }) => selected.has(name))
				: inspection.tools,
			inputs,
		};
	}

	async call(
		chatId: string,
		sessionId: string | undefined,
		calls: ToolInput[],
		requestId: unknown,
		signal: AbortSignal,
	): Promise<CallResult> {
		const { sessionId: target } = await this.#selectSession(
			chatId,
			sessionId,
			signal,
		);
		const toolCalls: ToolCall[] = calls.map((call) => ({
			type: "toolCall",
			id: `chappie-${randomUUID()}`,
			name: call.name,
			arguments: call.arguments,
		}));
		const result = await this.#request(
			target,
			(id) => ({
				type: "call",
				id,
				...source(chatId, requestId),
				sessionId: target,
				calls: toolCalls,
				fileRecipient: "ChatGPT",
			}),
			signal,
		);
		if ("toolResults" in result) {
			await this.#ackInputs(target, result.inputs, signal);
			return {
				sessionId: target,
				cwd: result.cwd,
				toolResults: result.toolResults,
				inputs: result.inputs,
				...("cancelled" in result ? { cancelled: result.cancelled } : {}),
			};
		}
		throw new Error("Session returned no tool results");
	}

	async history(
		chatId: string,
		sessionId: string | undefined,
		signal: AbortSignal,
	) {
		const { sessionId: target } = await this.#selectSession(
			chatId,
			sessionId,
			signal,
		);
		const result = await this.#request(
			target,
			(id) => ({ type: "history", id, sessionId: target }),
			signal,
		);
		if ("history" in result) return { sessionId: target, ...result };
		throw new Error("Session returned no history");
	}

	async inputs(
		chatId: string,
		sessionId: string | undefined,
		signal: AbortSignal,
	): Promise<SessionInput[]> {
		const target = sessionId ?? this.#state.binding(chatId);
		if (!target || !this.#sessions.has(target)) return [];
		const result = await this.#request(
			target,
			(id) => ({ type: "inputs", id, sessionId: target }),
			signal,
		);
		if (!("inputs" in result)) throw new Error("Session returned no inputs");
		await this.#ackInputs(target, result.inputs, signal);
		return result.inputs;
	}

	async readResource(uri: string, signal: AbortSignal): Promise<ResourceData> {
		const sessionId = resourceSessionId(uri);
		const result = await this.#request(
			sessionId,
			(id) => ({ type: "readResource", id, sessionId, uri }),
			signal,
		);
		if ("resource" in result) return result.resource;
		throw new Error("Session returned no resource");
	}

	deliveries(chatId: string): DeliveryRecord[] {
		return this.#state.deliveries(chatId);
	}

	acknowledge(
		deliveries: DeliveryRecord[],
		signal: AbortSignal,
	): Promise<void> {
		return this.#state.acknowledge(deliveries, signal);
	}

	async request(
		request: ClientRequest,
		signal: AbortSignal,
	): Promise<SessionResult> {
		if (request.type === "sessions")
			return {
				sessions: this.listSessions(request.sessionId),
				devices: this.listDevices(),
			};
		if (request.type === "launch") return this.launch(request, signal);
		const result = await this.#request(
			request.sessionId,
			(id) => ({ ...request, id }),
			signal,
		);
		if ("inputs" in result)
			await this.#ackInputs(request.sessionId, result.inputs, signal);
		return result;
	}

	async #receive(
		peer: JsonLinePeer<SessionMessage, BrokerMessage>,
		message: SessionMessage,
	): Promise<void> {
		switch (message.type) {
			case "client":
				this.#clients.set(peer, message.device);
				break;
			case "launching": {
				const launch = this.#launches.get(message.id);
				if (launch) launch.worker = peer;
				else await peer.send({ type: "launchDone", id: message.id });
				break;
			}
			case "launched": {
				const launch = this.#launches.get(message.id);
				if (
					!launch ||
					(launch.worker !== peer &&
						this.#clients.get(peer)?.id !== launch.device)
				)
					break;
				if ("error" in message) launch.reject(new Error(message.error));
				else {
					launch.sessionId = message.sessionId;
					if (this.#sessions.has(message.sessionId))
						launch.resolve(message.sessionId);
				}
				break;
			}
			case "request": {
				let relays = this.#relays.get(peer);
				if (!relays) {
					relays = new Map();
					this.#relays.set(peer, relays);
				}
				const controller = new AbortController();
				relays.set(message.id, controller);
				void this.request(message.request, controller.signal)
					.then(
						async (result) => {
							const deliveries = this.#state.deliveries(message.clientId);
							await peer.send({
								...result,
								type: "response",
								id: message.id,
								...(deliveries.length ? { deliveries } : {}),
							});
							await this.#state.acknowledge(deliveries, controller.signal);
						},
						(error: unknown) =>
							peer.send({
								type: "response",
								id: message.id,
								error: error instanceof Error ? error.message : String(error),
							}),
					)
					.finally(() => relays.delete(message.id))
					.catch(() => {});
				break;
			}
			case "resources":
				for (const resource of message.resources)
					this.#resources.set(resource.uri, peer);
				break;
			case "cancelRequest":
				this.#relays
					.get(peer)
					?.get(message.id)
					?.abort(new Error("Request cancelled"));
				break;
			case "sync": {
				const registered =
					this.#sessions.get(message.session.id)?.peer === peer;
				this.#sessions.set(message.session.id, {
					description: message.session,
					peer,
				});
				for (const launch of this.#launches.values())
					if (launch.sessionId === message.session.id)
						launch.resolve(message.session.id);
				await peer.send({
					type: "synced",
					id: message.id,
					sessionId: message.session.id,
				});
				if (!registered)
					await this.#notify(message.session.id, "Chappie connected", {
						event: "connected",
					});
				this.#notifyChange();
				break;
			}
			case "unregister": {
				const session = this.#sessions.get(message.sessionId);
				if (session?.peer === peer) this.#removeSession(message.sessionId);
				break;
			}
			case "delivery":
				await this.#state.addDelivery(message.delivery);
				await peer.send({ type: "stored", id: message.delivery.id });
				break;
			case "result": {
				const pending = this.#pending.get(message.id);
				if (!pending || pending.peer !== peer) break;
				this.#finishRequest(message.id, pending);
				if ("error" in message) pending.reject(new Error(message.error));
				else {
					const { type: _type, id: _id, ...result } = message;
					pending.resolve(result);
				}
				break;
			}
		}
	}

	async #selectSession(
		chatId: string,
		requestedId: string | undefined,
		signal: AbortSignal,
	): Promise<{
		sessionId: string;
		selection: InitializedSession["selection"];
	}> {
		signal.throwIfAborted();
		const target = requestedId ?? this.#state.binding(chatId);
		if (!target)
			throw new Error(
				"Specify a sessionId or select a default session with init",
			);
		await this.#waitForSession(target, signal);
		signal.throwIfAborted();
		return {
			sessionId: target,
			selection: requestedId ? "explicit" : "existing",
		};
	}

	async #join(
		chatId: string,
		sessionId: string,
		requestId: unknown,
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
		const previous = this.#state.binding(chatId);
		await this.#state.bind(chatId, sessionId);
		signal.throwIfAborted();
		const activity = source(chatId, requestId);
		if (previous && previous !== sessionId)
			await this.#notify(previous, `${sourceLabel(activity)} left`, {
				...activity,
				event: "left",
			});
		signal.throwIfAborted();
		await this.#notify(sessionId, `${sourceLabel(activity)} joined`, {
			...activity,
			event: "joined",
		});
	}

	async #notify(
		sessionId: string,
		message: string,
		activity: Activity = {},
	): Promise<void> {
		await this.#sessions
			.get(sessionId)
			?.peer.send({ type: "notice", sessionId, message, activity });
	}

	async #waitForSession(sessionId: string, signal: AbortSignal): Promise<void> {
		while (!this.#sessions.has(sessionId)) await this.#waitForChange(signal);
	}

	async #inspect(
		sessionId: string,
		signal: AbortSignal,
	): Promise<Extract<SessionResult, { inspection: SessionInspection }>> {
		const result = await this.#request(
			sessionId,
			(id) => ({ type: "inspect", id, sessionId }),
			signal,
		);
		if ("inspection" in result) return result;
		throw new Error("Session returned no inspection");
	}

	async #ackInputs(
		sessionId: string,
		inputs: SessionInput[],
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
		if (inputs.length === 0) return;
		const session = this.#sessions.get(sessionId);
		if (!session) throw new Error(`Session ${sessionId} is offline`);
		await session.peer.send({
			type: "ackInputs",
			sessionId,
			ids: inputs.map(({ id }) => id),
		});
	}

	async #request(
		sessionId: string,
		message: (id: number) => BrokerMessage,
		signal: AbortSignal,
	): Promise<SessionResult> {
		if (signal.aborted) throw abortError(signal);
		const id = this.#nextRequestId++;
		const request = message(id);
		const peer =
			request.type === "readResource"
				? this.#resources.get(request.uri)
				: this.#sessions.get(sessionId)?.peer;
		if (!peer)
			throw new Error(
				`Session resource or target is unavailable: ${sessionId}`,
			);
		const completion = Promise.withResolvers<SessionResult>();
		const onAbort = (): void => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			void pending.peer
				.send({
					type: "cancel",
					id,
					sessionId,
					reason: abortError(signal).message,
				})
				.catch(() => {});
			this.#finishRequest(id, pending);
			pending.reject(abortError(signal));
		};
		const pending: PendingRequest = {
			peer,
			resolve: completion.resolve,
			reject: completion.reject,
			signal,
			onAbort,
		};
		this.#pending.set(id, pending);
		signal.addEventListener("abort", onAbort, { once: true });
		void peer.send(request).catch((error: unknown) => {
			this.#finishRequest(id, pending);
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		});
		return completion.promise;
	}

	#waitForChange(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(abortError(signal));
		const completion = Promise.withResolvers<void>();
		const onAbort = (): void => {
			this.#waiters.delete(waiter);
			waiter.reject(abortError(signal));
		};
		const waiter: ChangeWaiter = {
			resolve: completion.resolve,
			reject: completion.reject,
			signal,
			onAbort,
		};
		this.#waiters.add(waiter);
		signal.addEventListener("abort", onAbort, { once: true });
		return completion.promise;
	}

	#notifyChange(): void {
		for (const waiter of this.#waiters) {
			this.#waiters.delete(waiter);
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.resolve();
		}
	}

	#finishRequest(id: number, pending: PendingRequest): void {
		this.#pending.delete(id);
		pending.signal.removeEventListener("abort", pending.onAbort);
	}

	#removePeer(peer: JsonLinePeer<SessionMessage, BrokerMessage>): void {
		this.#clients.delete(peer);
		for (const launch of this.#launches.values())
			if ((launch.worker ?? launch.peer) === peer)
				launch.reject(new Error("Session launcher disconnected"));
		for (const controller of this.#relays.get(peer)?.values() ?? []) {
			controller.abort(new Error("Session disconnected"));
		}
		this.#relays.delete(peer);
		for (const [uri, owner] of this.#resources) {
			if (owner === peer) this.#resources.delete(uri);
		}
		for (const [sessionId, session] of this.#sessions) {
			if (session.peer === peer) this.#removeSession(sessionId);
		}
		for (const [id, pending] of this.#pending) {
			if (pending.peer !== peer) continue;
			this.#finishRequest(id, pending);
			pending.reject(new Error("Session disconnected"));
		}
	}

	#removeSession(sessionId: string): void {
		this.#sessions.delete(sessionId);
		this.#notifyChange();
	}
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error(
				typeof signal.reason === "string" ? signal.reason : "Request cancelled",
			);
}
