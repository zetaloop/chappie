import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	AssistantMessage,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	type DeliveryRecord,
	type ResolvedDelivery,
	resolveDelivery,
} from "./delivery.ts";
import {
	type BrokerMessage,
	IpcServer,
	type JsonLinePeer,
	type SessionDescription,
	type SessionInput,
	type SessionInspection,
	type SessionMessage,
	type SessionResult,
} from "./ipc.ts";
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

export interface InitializedSession extends SessionInspection {
	globalAgents?: string;
	inputs: SessionInput[];
}

export interface InspectedSession extends SessionInspection {
	inputs: SessionInput[];
}

export interface ChatResult {
	message: AssistantMessage;
	inputs: SessionInput[];
}

export interface CallResult {
	sessionId: string;
	toolResults: ToolResultMessage[];
	inputs: SessionInput[];
}

export class Broker {
	readonly #agentDir: string;
	readonly #ipc: IpcServer;
	readonly #state: State;
	readonly #sessions = new Map<string, RegisteredSession>();
	readonly #ready = new Set<string>();
	readonly #pending = new Map<number, PendingRequest>();
	readonly #waiters = new Set<ChangeWaiter>();
	#nextRequestId = 1;

	constructor(agentDir: string) {
		this.#agentDir = agentDir;
		this.#state = new State(agentDir);
		this.#ipc = new IpcServer(
			agentDir,
			(peer, message) => this.#receive(peer, message),
			(peer) => this.#removePeer(peer),
		);
	}

	async start(): Promise<void> {
		await this.#state.load();
		await this.#ipc.start();
	}

	async close(): Promise<void> {
		const error = new Error("Chappie broker ended");
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
		this.#ready.clear();
		await this.#ipc.close();
	}

	listSessions(sessionId?: string): SessionDescription[] {
		if (sessionId) {
			const session = this.#sessions.get(sessionId);
			return session ? [session.description] : [];
		}
		return [...this.#sessions.values()].map(({ description }) => description);
	}

	binding(chatId: string): string | undefined {
		return this.#state.binding(chatId);
	}

	async initialize(
		chatId: string,
		sessionId: string | undefined,
		signal: AbortSignal,
	): Promise<InitializedSession> {
		const target = await this.#selectSession(chatId, sessionId, signal, true);
		const { inspection, inputs } = await this.#inspect(target, signal);
		const globalAgents = await this.#readGlobalAgents();
		await this.#ackInputs(target, inputs);
		return { ...inspection, inputs, ...(globalAgents ? { globalAgents } : {}) };
	}

	async chat(
		chatId: string,
		sessionId: string | undefined,
		text: string,
		signal: AbortSignal,
	): Promise<ChatResult> {
		const target = await this.#selectSession(chatId, sessionId, signal, false);
		const result = await this.#request(
			target,
			(id) => ({ type: "chat", id, chatId, sessionId: target, text }),
			signal,
		);
		if ("message" in result) {
			await this.#ackInputs(target, result.inputs);
			return { message: result.message, inputs: result.inputs };
		}
		throw new Error("Pi session returned no assistant message");
	}

	async tools(
		chatId: string,
		sessionId: string | undefined,
		signal: AbortSignal,
	): Promise<InspectedSession> {
		const target = await this.#selectSession(chatId, sessionId, signal, false);
		const { inspection, inputs } = await this.#inspect(target, signal);
		await this.#ackInputs(target, inputs);
		return { ...inspection, inputs };
	}

	async call(
		chatId: string,
		sessionId: string | undefined,
		calls: ToolInput[],
		signal: AbortSignal,
	): Promise<CallResult> {
		const target = await this.#selectSession(chatId, sessionId, signal, false);
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
				chatId,
				sessionId: target,
				calls: toolCalls,
			}),
			signal,
		);
		if ("toolResults" in result) {
			await this.#ackInputs(target, result.inputs);
			return {
				sessionId: target,
				toolResults: result.toolResults,
				inputs: result.inputs,
			};
		}
		throw new Error("Pi session returned no tool results");
	}

	async inputs(
		chatId: string,
		sessionId: string | undefined,
		signal: AbortSignal,
	): Promise<SessionInput[]> {
		const target = sessionId ?? this.#state.binding(chatId);
		if (!target) return [];
		await this.#waitForSession(target, signal);
		const { inputs } = await this.#inspect(target, signal);
		await this.#ackInputs(target, inputs);
		return inputs;
	}

	async readResource(uri: string, signal: AbortSignal): Promise<ResourceData> {
		const sessionId = resourceSessionId(uri);
		await this.#waitForSession(sessionId, signal);
		const result = await this.#request(
			sessionId,
			(id) => ({ type: "readResource", id, sessionId, uri }),
			signal,
		);
		if ("resource" in result) return result.resource;
		throw new Error("Pi session returned no resource");
	}

	async deliveries(chatId: string): Promise<ResolvedDelivery[]> {
		return Promise.all(this.#state.deliveries(chatId).map(resolveDelivery));
	}

	async acknowledgeDeliveries(
		deliveries: DeliveryRecord[],
		signal: AbortSignal,
	): Promise<void> {
		if (deliveries.length === 0) return;
		if (signal.aborted) throw abortError(signal);
		await this.#state.removeDeliveries(deliveries.map(({ id }) => id));
		if (!signal.aborted) return;
		await this.#state.restoreDeliveries(deliveries);
		throw abortError(signal);
	}

	async #receive(
		peer: JsonLinePeer<SessionMessage, BrokerMessage>,
		message: SessionMessage,
	): Promise<void> {
		switch (message.type) {
			case "sync": {
				const previous = this.#sessions.get(message.session.id);
				this.#sessions.set(message.session.id, {
					description: message.session,
					peer,
				});
				if (message.session.status === "ready") {
					if (previous?.description.status !== "ready")
						this.#ready.add(message.session.id);
				} else {
					this.#ready.delete(message.session.id);
				}
				this.#notifyChange();
				await peer.send({
					type: "synced",
					id: message.id,
					sessionId: message.session.id,
				});
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
		bindRequested: boolean,
	): Promise<string> {
		if (requestedId) {
			await this.#waitForSession(requestedId, signal);
			if (bindRequested && this.#state.binding(chatId) !== requestedId) {
				await this.#state.setBinding(chatId, requestedId);
				this.#notifyChange();
			}
			return requestedId;
		}

		const boundId = this.#state.binding(chatId);
		if (boundId) {
			await this.#waitForSession(boundId, signal);
			return boundId;
		}

		for (;;) {
			const occupied = this.#state.boundSessions();
			const candidate = [...this.#ready].find(
				(sessionId) =>
					this.#sessions.has(sessionId) && !occupied.has(sessionId),
			);
			if (candidate) {
				await this.#state.setBinding(chatId, candidate);
				this.#notifyChange();
				return candidate;
			}
			await this.#waitForChange(signal);
		}
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
		throw new Error("Pi session returned no inspection");
	}

	async #ackInputs(sessionId: string, inputs: SessionInput[]): Promise<void> {
		if (inputs.length === 0) return;
		const session = this.#sessions.get(sessionId);
		if (!session) throw new Error(`Pi session ${sessionId} is offline`);
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
		const session = this.#sessions.get(sessionId);
		if (!session) throw new Error(`Pi session ${sessionId} is offline`);
		if (signal.aborted) throw abortError(signal);
		const id = this.#nextRequestId++;
		const completion = Promise.withResolvers<SessionResult>();
		const onAbort = (): void => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			void pending.peer.send({ type: "cancel", id, sessionId }).catch(() => {});
			this.#finishRequest(id, pending);
			pending.reject(abortError(signal));
		};
		const pending: PendingRequest = {
			peer: session.peer,
			resolve: completion.resolve,
			reject: completion.reject,
			signal,
			onAbort,
		};
		this.#pending.set(id, pending);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await session.peer.send(message(id));
		} catch (error) {
			this.#finishRequest(id, pending);
			throw error;
		}
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
		for (const [sessionId, session] of this.#sessions) {
			if (session.peer === peer) this.#removeSession(sessionId);
		}
		for (const [id, pending] of this.#pending) {
			if (pending.peer !== peer) continue;
			this.#finishRequest(id, pending);
			pending.reject(new Error("Pi session disconnected"));
		}
	}

	#removeSession(sessionId: string): void {
		this.#sessions.delete(sessionId);
		this.#ready.delete(sessionId);
		this.#notifyChange();
	}

	async #readGlobalAgents(): Promise<string | undefined> {
		try {
			return await readFile(join(this.#agentDir, "AGENTS.md"), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("Request cancelled");
}
