import { randomUUID } from "node:crypto";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { type Activity, chatLabel, source } from "./activity.ts";
import { readConfig } from "./config.ts";
import type { DeliveryRecord } from "./delivery.ts";
import { type HistoryRange, historyInstructions } from "./history.ts";
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

const observerInstructions =
	"This ChatGPT conversation recently initialized or resumed work in this Pi session. A parallel execution is already continuing the task. Participate as an observer for this task: read history with observer: true, follow new entries with after and wait: true, and think independently. Leave execution and Pi communication to the ongoing work. Once its completion is recorded, explain the actual results in ChatGPT and finish your response. Continue observing this task rather than reinitializing to take over.";

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

export interface Initialization {
	sessionId: string;
	instructions: string;
}

export interface InitializedSession extends Omit<SessionInspection, "tools"> {
	selection: "existing" | "explicit" | "automatic";
	initialization?: Initialization;
	globalAgents?: string;
	inputs: SessionInput[];
	tools: { name: string; description: string }[];
}

export interface InspectedSession extends SessionInspection {
	initialization?: Initialization;
	inputs: SessionInput[];
}

export interface ChatResult {
	initialization?: Initialization;
	sessionId: string;
	cwd: string;
	inputs: SessionInput[];
}

export interface CallResult extends ChatResult {
	toolResults: ToolResultMessage[];
}

export class Broker {
	readonly #agentDir: string;
	readonly #ipc: IpcServer;
	readonly #state: State;
	readonly #sessions = new Map<string, RegisteredSession>();
	readonly #pending = new Map<number, PendingRequest>();
	readonly #waiters = new Set<ChangeWaiter>();
	readonly #cooldowns = new Map<string, number>();
	#ask = true;
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
		this.#ask = config.ask ?? true;
		await this.#state.load();
		await this.#ipc.start(config.listen ?? false);
	}

	async close(): Promise<void> {
		const error = new Error("Chappie broker ended");
		this.#cooldowns.clear();
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

	get askEnabled(): boolean {
		return this.#ask;
	}

	binding(chatId: string): string | undefined {
		return this.#state.binding(chatId);
	}

	async initialize(
		chatId: string,
		sessionId: string | undefined,
		requestId: unknown,
		signal: AbortSignal,
	): Promise<InitializedSession> {
		const {
			sessionId: target,
			selection,
			initialization,
		} = await this.#selectSession(chatId, sessionId, requestId, signal, true);
		const { inspection, inputs, globalAgents } = await this.#inspect(
			target,
			signal,
		);
		await this.#ackInputs(target, inputs, signal);
		return {
			selection,
			...(initialization ? { initialization } : {}),
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
	): Promise<ChatResult> {
		const { sessionId: target, initialization } = await this.#selectSession(
			chatId,
			sessionId,
			requestId,
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
			}),
			signal,
		);
		if ("message" in result) {
			const inputs = result.inputs;
			await this.#ackInputs(target, inputs, signal);
			return {
				sessionId: target,
				cwd: result.cwd,
				inputs,
				...(initialization ? { initialization } : {}),
			};
		}
		throw new Error("Pi session returned no assistant message");
	}

	async tools(
		chatId: string,
		sessionId: string | undefined,
		names: string[] | undefined,
		requestId: unknown,
		signal: AbortSignal,
	): Promise<InspectedSession> {
		const { sessionId: target, initialization } = await this.#selectSession(
			chatId,
			sessionId,
			requestId,
			signal,
		);
		const { inspection, inputs } = await this.#inspect(target, signal);
		await this.#ackInputs(target, inputs, signal);
		const selected = names ? new Set(names) : undefined;
		return {
			...inspection,
			...(initialization ? { initialization } : {}),
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
		const { sessionId: target, initialization } = await this.#selectSession(
			chatId,
			sessionId,
			requestId,
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
			}),
			signal,
		);
		if ("toolResults" in result) {
			await this.#ackInputs(target, result.inputs, signal);
			return {
				sessionId: target,
				...(initialization ? { initialization } : {}),
				cwd: result.cwd,
				toolResults: result.toolResults,
				inputs: result.inputs,
			};
		}
		throw new Error("Pi session returned no tool results");
	}

	async history(
		chatId: string,
		sessionId: string | undefined,
		range: HistoryRange,
		requestId: unknown,
		signal: AbortSignal,
	) {
		const target = sessionId ?? this.#state.binding(chatId);
		if (!target) throw new Error("Specify a Pi sessionId to read history");
		await this.#waitForSession(target, signal);
		const result = await this.#request(
			target,
			(id) => ({
				type: "history",
				id,
				sessionId: target,
				range,
				...source(chatId, requestId),
			}),
			signal,
		);
		if ("history" in result) return { sessionId: target, ...result };
		throw new Error("Pi session returned no history");
	}

	async inputs(
		chatId: string,
		sessionId: string | undefined,
		signal: AbortSignal,
	): Promise<SessionInput[]> {
		const target = sessionId ?? this.#state.binding(chatId);
		if (!target || !this.#sessions.has(target)) return [];
		const { inputs } = await this.#inspect(target, signal);
		await this.#ackInputs(target, inputs, signal);
		return inputs;
	}

	async ask(
		chatId: string,
		sessionId: string | undefined,
		input: QuestionInput,
		requestId: unknown,
		signal: AbortSignal,
	): Promise<Question & { initialization?: Initialization }> {
		const { sessionId: target, initialization } = await this.#selectSession(
			chatId,
			sessionId,
			requestId,
			signal,
		);
		signal.throwIfAborted();
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
		const activity = source(chatId, requestId);
		void this.#notify(
			target,
			`${chatLabel(activity)} asked: ${question.question}`,
			{
				event: "asked",
				...activity,
			},
		).catch(() => {});
		return {
			...questionView(question),
			...(initialization ? { initialization } : {}),
		};
	}

	async assertQuestion(
		chatId: string,
		id: string,
		signal: AbortSignal,
	): Promise<Question> {
		const timeout = AbortSignal.timeout(10_000);
		const combined = AbortSignal.any([signal, timeout]);
		try {
			for (;;) {
				signal.throwIfAborted();
				const question = this.#state.question(chatId, id);
				if (question.loaded) return questionView(question);
				await this.#waitForChange(combined);
			}
		} catch (error) {
			signal.throwIfAborted();
			if (!timeout.aborted) throw error;
			const question = this.#state.question(chatId, id);
			if (question.loaded) return questionView(question);
			if (!question.answer) {
				await this.#state.answer(chatId, id, {
					selections: [],
					text: "",
					skipped: true,
				});
				void this.#notify(
					question.sessionId,
					`Question skipped after display timeout: ${question.question}`,
					{ event: "skipped", chatId },
				).catch(() => {});
			}
			throw new Error(
				"Question widget did not load within 10 seconds. The question was automatically skipped. Use an installed Pi interactive tool through call if an answer is needed.",
			);
		}
	}

	async answer(
		chatId: string,
		id: string,
		answer?: QuestionAnswer,
		loaded = false,
	): Promise<Question> {
		let question = this.#state.question(chatId, id);
		if ((loaded || answer) && !question.loaded) {
			this.#cooldown(chatId, question.sessionId);
			question = { ...question, loaded: true };
			await this.#state.addQuestion(question);
			this.#notifyChange();
		}
		if (answer) {
			const previous = question.answer;
			question = await this.#state.answer(chatId, id, answer);
			if (question.answer !== previous) {
				const response = [
					...(question.answer?.selections ?? []).map(
						(index) => question.options[index]?.title,
					),
					question.answer?.text,
				]
					.filter(Boolean)
					.join(", ");
				const message = question.answer?.skipped
					? `Skipped in ChatGPT ${chatId.slice(-4)}: ${question.question}`
					: previous
						? `Answer updated in ChatGPT ${chatId.slice(-4)}: ${question.question} — ${response}`
						: `Answered in ChatGPT ${chatId.slice(-4)}: ${question.question} — ${response}`;
				void this.#notify(question.sessionId, message, {
					event: question.answer?.skipped ? "skipped" : "answered",
					chatId,
				}).catch(() => {});
			}
		}
		return questionView(question);
	}

	answers(chatId: string): QuestionRecord[] {
		return this.#state.answers(chatId);
	}

	async readResource(uri: string, signal: AbortSignal): Promise<ResourceData> {
		const requested = new URL(uri);
		const chatId = requested.searchParams.get("chatId");
		requested.search = "";
		const sessionId = resourceSessionId(requested.href);
		if (chatId) this.#cooldown(chatId, sessionId);
		await this.#waitForSession(sessionId, signal);
		const result = await this.#request(
			sessionId,
			(id) => ({ type: "readResource", id, sessionId, uri: requested.href }),
			signal,
		);
		if ("resource" in result) {
			if (chatId) this.#cooldown(chatId, sessionId);
			return { ...result.resource, uri };
		}
		throw new Error("Pi session returned no resource");
	}

	deliveries(chatId: string): DeliveryRecord[] {
		return this.#state.deliveries(chatId);
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
		requestId: unknown,
		signal: AbortSignal,
		bindRequested = false,
	): Promise<{
		sessionId: string;
		selection: InitializedSession["selection"];
		initialization?: Initialization;
	}> {
		for (;;) {
			signal.throwIfAborted();
			const boundId = this.#state.binding(chatId);
			let target = requestedId ?? boundId;
			if (!target) {
				const occupied = this.#state.bindingCounts();
				target = [...this.#sessions.keys()].find((id) => !occupied.has(id));
			}
			if (!target) {
				await this.#waitForChange(signal);
				continue;
			}
			await this.#waitForSession(target, signal);
			signal.throwIfAborted();
			const initialization =
				bindRequested || !this.#state.binding(chatId)
					? await this.#join(chatId, target, requestId, signal, bindRequested)
					: undefined;
			return {
				sessionId: target,
				selection: requestedId
					? "explicit"
					: boundId
						? "existing"
						: "automatic",
				...(initialization ? { initialization } : {}),
			};
		}
	}

	async #join(
		chatId: string,
		sessionId: string,
		requestId: unknown,
		signal: AbortSignal,
		explicit = false,
	): Promise<Initialization> {
		signal.throwIfAborted();
		const previous = this.#state.binding(chatId);
		const key = JSON.stringify([chatId, sessionId]);
		const observer = (this.#cooldowns.get(key) ?? 0) > Date.now();
		if (!observer) this.#cooldown(chatId, sessionId);
		await this.#state.bind(chatId, sessionId);
		signal.throwIfAborted();
		const activity = source(chatId, requestId);
		if (previous !== sessionId) {
			this.#notifyChange();
			if (previous)
				await this.#notify(previous, `${chatLabel(activity)} left`, {
					...activity,
					event: "left",
				});
		}
		signal.throwIfAborted();
		await this.#notify(sessionId, `${chatLabel(activity)} joined`, {
			...activity,
			event: "joined",
			initialization: explicit ? "explicit" : "implicit",
		});
		return {
			sessionId,
			instructions: observer ? observerInstructions : historyInstructions,
		};
	}

	#cooldown(chatId: string, sessionId: string): void {
		const now = Date.now();
		for (const [key, expires] of this.#cooldowns) {
			if (expires <= now) this.#cooldowns.delete(key);
		}
		this.#cooldowns.set(JSON.stringify([chatId, sessionId]), now + 10_000);
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
		throw new Error("Pi session returned no inspection");
	}

	async #ackInputs(
		sessionId: string,
		inputs: SessionInput[],
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
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
		void session.peer.send(message(id)).catch((error: unknown) => {
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
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error(
				typeof signal.reason === "string" ? signal.reason : "Request cancelled",
			);
}
