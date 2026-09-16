import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { readConfig } from "./config.ts";
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
import {
	type Question,
	type QuestionAnswer,
	type QuestionInput,
	type QuestionRecord,
	questionView,
} from "./questions.ts";
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

interface Workflow {
	id: string;
	controller: AbortController;
}

interface ChangeWaiter {
	resolve(): void;
	reject(error: Error): void;
	signal: AbortSignal;
	onAbort(): void;
}

export interface InitializedSession extends Omit<SessionInspection, "tools"> {
	selection: "existing" | "explicit" | "automatic";
	globalAgents?: string;
	inputs: SessionInput[];
	tools: { name: string; description: string }[];
}

export interface InspectedSession extends SessionInspection {
	inputs: SessionInput[];
}

export interface ChatResult {
	sessionId: string;
	cwd: string;
	inputs: SessionInput[];
}

export interface CallResult {
	sessionId: string;
	cwd: string;
	toolResults: ToolResultMessage[];
	inputs: SessionInput[];
}

export class Broker {
	readonly #agentDir: string;
	readonly #ipc: IpcServer;
	readonly #state: State;
	readonly #sessions = new Map<string, RegisteredSession>();
	readonly #pending = new Map<number, PendingRequest>();
	readonly #waiters = new Set<ChangeWaiter>();
	readonly #workflows = new Map<string, Workflow>();
	#latestWorkflow = false;
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
		const config = await readConfig(this.#agentDir);
		this.#latestWorkflow = config.latestWorkflow ?? false;
		await this.#state.load();
		await this.#ipc.start();
	}

	async close(): Promise<void> {
		const error = new Error("Chappie broker ended");
		for (const workflow of this.#workflows.values()) {
			workflow.controller.abort(error);
		}
		this.#workflows.clear();
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
		await this.#ipc.close();
	}

	async workflow(
		chatId: string | undefined,
		requestId: unknown,
		signal: AbortSignal,
	): Promise<AbortSignal> {
		if (!this.#latestWorkflow || !chatId) return signal;
		const id =
			typeof requestId === "string"
				? /^wfr_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}(?=\/|$)/i
						.exec(requestId)?.[0]
						.toLowerCase()
				: undefined;
		if (!id) return signal;
		signal.throwIfAborted();
		const latest = this.#state.workflow(chatId);
		const superseded = new Error(
			"A newer workflow has taken over this ChatGPT conversation. Tool access for this workflow has ended. Stop this workflow; the newer workflow is handling the task.",
		);
		// UUIDv7 puts the creation timestamp first, including across broker restarts.
		if (latest && id < latest) throw superseded;
		let workflow = this.#workflows.get(chatId);
		if (!workflow || workflow.id !== id) {
			const previous = workflow;
			workflow = { id, controller: new AbortController() };
			this.#workflows.set(chatId, workflow);
			previous?.controller.abort(superseded);
			if (latest !== id) await this.#state.setWorkflow(chatId, id);
		}
		const combined = AbortSignal.any([signal, workflow.controller.signal]);
		combined.throwIfAborted();
		return combined;
	}

	listSessions(
		sessionId?: string,
	): (SessionDescription & { bindingCount: number })[] {
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

	async initialize(
		chatId: string,
		sessionId: string | undefined,
		signal: AbortSignal,
	): Promise<InitializedSession> {
		const { sessionId: target, selection } = await this.#selectSession(
			chatId,
			sessionId,
			signal,
			true,
		);
		const { inspection, inputs } = await this.#inspect(target, signal);
		const globalAgents = await this.#readGlobalAgents();
		await this.#ackInputs(target, inputs);
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
		signal: AbortSignal,
	): Promise<ChatResult> {
		const { sessionId: target } = await this.#selectSession(
			chatId,
			sessionId,
			signal,
			false,
		);
		const result = await this.#request(
			target,
			(id) => ({ type: "chat", id, chatId, sessionId: target, text }),
			signal,
		);
		if ("message" in result) {
			await this.#ackInputs(target, result.inputs);
			return { sessionId: target, cwd: result.cwd, inputs: result.inputs };
		}
		throw new Error("Pi session returned no assistant message");
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
			false,
		);
		const { inspection, inputs } = await this.#inspect(target, signal);
		await this.#ackInputs(target, inputs);
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
		signal: AbortSignal,
	): Promise<CallResult> {
		const { sessionId: target } = await this.#selectSession(
			chatId,
			sessionId,
			signal,
			false,
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
				cwd: result.cwd,
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
		if (!target || !this.#sessions.has(target)) return [];
		const { inputs } = await this.#inspect(target, signal);
		await this.#ackInputs(target, inputs);
		return inputs;
	}

	async ask(
		chatId: string,
		sessionId: string | undefined,
		input: QuestionInput,
		signal: AbortSignal,
	): Promise<Question> {
		const { sessionId: target } = await this.#selectSession(
			chatId,
			sessionId,
			signal,
			false,
		);
		const session = this.#sessions.get(target);
		if (!session) throw new Error(`Pi session ${target} is offline`);
		const question: QuestionRecord = {
			...input,
			id: randomUUID(),
			chatId,
			sessionId: target,
			cwd: session.description.cwd,
			delivered: false,
		};
		await this.#state.addQuestion(question);
		return questionView(question);
	}

	async answer(
		chatId: string,
		id: string,
		answer?: QuestionAnswer,
	): Promise<Question> {
		return questionView(
			answer
				? await this.#state.answer(chatId, id, answer)
				: this.#state.question(chatId, id),
		);
	}

	answers(chatId: string): QuestionRecord[] {
		return this.#state.answers(chatId);
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

	acknowledge(
		deliveries: DeliveryRecord[],
		answers: QuestionRecord[],
		signal: AbortSignal,
	): Promise<void> {
		return this.#state.acknowledge(deliveries, answers, signal);
	}

	async #receive(
		peer: JsonLinePeer<SessionMessage, BrokerMessage>,
		message: SessionMessage,
	): Promise<void> {
		switch (message.type) {
			case "sync": {
				const registered =
					this.#sessions.get(message.session.id)?.peer === peer;
				this.#sessions.set(message.session.id, {
					description: message.session,
					peer,
				});
				await peer.send({
					type: "synced",
					id: message.id,
					sessionId: message.session.id,
				});
				if (!registered) {
					const chats = this.#state.chats(message.session.id);
					await this.#notify(
						message.session.id,
						chats.length
							? `Chappie broker connected. Restored ChatGPT pairing ${chats.map((id) => `…${id.slice(-8)}`).join(", ")}.`
							: "Chappie broker connected. Waiting for ChatGPT to pair.",
					);
				}
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
		bindRequested: boolean,
	): Promise<{
		sessionId: string;
		selection: InitializedSession["selection"];
	}> {
		if (requestedId) {
			await this.#waitForSession(requestedId, signal);
			if (bindRequested && this.#state.binding(chatId) !== requestedId) {
				await this.#bind(chatId, requestedId);
			}
			return { sessionId: requestedId, selection: "explicit" };
		}

		const boundId = this.#state.binding(chatId);
		if (boundId) {
			await this.#waitForSession(boundId, signal);
			return { sessionId: boundId, selection: "existing" };
		}

		for (;;) {
			const occupied = this.#state.bindingCounts();
			const candidate = [...this.#sessions.keys()].find(
				(sessionId) => !occupied.has(sessionId),
			);
			if (candidate) {
				await this.#bind(chatId, candidate);
				return { sessionId: candidate, selection: "automatic" };
			}
			await this.#waitForChange(signal);
		}
	}

	async #bind(chatId: string, sessionId: string): Promise<void> {
		const previous = this.#state.binding(chatId);
		await this.#state.setBinding(chatId, sessionId);
		this.#notifyChange();
		if (previous) {
			await this.#notify(
				previous,
				`ChatGPT …${chatId.slice(-8)} selected another Pi session.`,
			);
			if (this.#state.chats(previous).length === 0) {
				await this.#notify(
					previous,
					"Waiting for ChatGPT to pair with this Pi session.",
				);
			}
		}
		await this.#notify(
			sessionId,
			`ChatGPT …${chatId.slice(-8)} paired with this Pi session.`,
		);
	}

	async #notify(sessionId: string, message: string): Promise<void> {
		await this.#sessions
			.get(sessionId)
			?.peer.send({ type: "notice", sessionId, message });
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
		: new Error(
				typeof signal.reason === "string" ? signal.reason : "Request cancelled",
			);
}
