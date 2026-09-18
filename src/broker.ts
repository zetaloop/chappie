import { randomBytes, randomUUID } from "node:crypto";
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

const coordinationInstructions =
	"Report your goal and progress through chat using your initialization name. The coordinator decides who continues, their tasks, and who exits. Follow the decision through chat and history; if asked to exit, leave a handoff and end this response.";

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

interface InitializationGrant {
	sessionId: string;
	code: string;
	previousCode: string | undefined;
	committed: boolean;
}

interface Operation {
	chatId: string;
	sessionId: string | undefined;
	controller: AbortController;
	communication: boolean;
	coordinating: boolean;
	revisions: Map<string, number>;
	initialization?: InitializationGrant;
}

interface ChangeWaiter {
	resolve(): void;
	reject(error: Error): void;
	signal: AbortSignal;
	onAbort(): void;
}

export interface Initialization {
	name?: string;
	code?: string;
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
	readonly #operations = new Map<AbortSignal, Operation>();
	readonly #locks = new Map<string, boolean>();
	readonly #startingLocks = new Set<string>();
	readonly #syncRevisions = new Map<string, number>();
	#ask = true;
	#sync = false;
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
		this.#sync = config.sync ?? false;
		await this.#state.load();
		await this.#ipc.start(config.listen ?? false);
	}

	async close(): Promise<void> {
		const error = new Error("Chappie broker ended");
		for (const operation of this.#operations.values()) {
			operation.controller.abort(error);
		}
		this.#operations.clear();
		this.#locks.clear();
		this.#startingLocks.clear();
		this.#syncRevisions.clear();
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

	async run<T>(
		chatId: string,
		sessionId: string | undefined,
		signal: AbortSignal,
		callback: (signal: AbortSignal) => Promise<T>,
		communication = false,
	): Promise<T> {
		if (!communication) this.#requireUnlocked(chatId, sessionId, signal);
		if (!this.#sync) return callback(signal);
		const controller = new AbortController();
		const combined = AbortSignal.any([signal, controller.signal]);
		const operation: Operation = {
			chatId,
			sessionId,
			controller,
			communication,
			coordinating: false,
			revisions: new Map(),
		};
		this.#operations.set(combined, operation);
		this.#observe(operation, this.#state.binding(chatId));
		this.#observe(operation, sessionId);
		try {
			const result = await callback(combined);
			combined.throwIfAborted();
			const initialization = operation.initialization;
			if (initialization) {
				initialization.previousCode = this.#state.code(
					initialization.sessionId,
				);
				initialization.committed = true;
				await this.#state.setCode(
					initialization.sessionId,
					initialization.code,
				);
				combined.throwIfAborted();
			}
			return result;
		} catch (error) {
			await this.#rollbackInitialization(operation);
			throw error;
		} finally {
			this.#operations.delete(combined);
		}
	}

	deliveryAllowed(signal: AbortSignal): boolean {
		const operation = this.#operations.get(signal);
		if (!operation?.communication) return true;
		if (operation.coordinating) return false;
		for (const [sessionId, revision] of operation.revisions) {
			if (
				this.#locks.has(sessionId) ||
				(this.#syncRevisions.get(sessionId) ?? 0) !== revision
			)
				return false;
		}
		return true;
	}

	get syncEnabled(): boolean {
		return this.#sync;
	}

	syncState(sessionId: string) {
		return {
			locked: this.#locks.has(sessionId),
			verified: this.#locks.get(sessionId) ?? false,
		};
	}

	synchronizing(chatId?: string, sessionId?: string): string | undefined {
		const boundId = chatId ? this.#state.binding(chatId) : undefined;
		if (boundId && this.#locks.has(boundId)) return boundId;
		if (sessionId && this.#locks.has(sessionId)) return sessionId;
		return undefined;
	}

	async sync(
		chatId: string,
		sessionId: string | undefined,
		action: "start" | "verify" | "release",
		code: string | undefined,
		requestId: unknown,
		signal: AbortSignal,
	) {
		if (!this.#sync) throw new Error("Session synchronization is disabled");
		signal.throwIfAborted();
		const target = sessionId ?? this.#state.binding(chatId);
		if (!target) throw new Error("Specify a Pi sessionId to synchronize");
		const locked = this.synchronizing(chatId);
		if (locked && locked !== target) throw new Error(syncMessage(locked));
		const activity = source(chatId, requestId);
		const result = { sessionId: target };
		if (action === "start") {
			if (!this.#locks.has(target)) {
				this.#locks.set(target, false);
				this.#startingLocks.add(target);
				this.#syncRevisions.set(
					target,
					(this.#syncRevisions.get(target) ?? 0) + 1,
				);
				const error = new Error(syncMessage(target));
				const rollbacks: Promise<void>[] = [];
				for (const operation of this.#operations.values()) {
					if (
						operation.sessionId !== target &&
						this.#state.binding(operation.chatId) !== target
					)
						continue;
					if (operation.initialization)
						rollbacks.push(this.#rollbackInitialization(operation));
					if (!operation.communication || operation.initialization)
						operation.controller.abort(error);
				}
				this.#notifyChange();
				try {
					await Promise.all(rollbacks);
					if (!this.#state.code(target)) {
						this.#locks.delete(target);
						this.#notifyChange();
						throw new Error(
							"Initialize this Pi session before starting synchronization",
						);
					}
					await this.#notify(
						target,
						`${chatLabel(activity)} started synchronization`,
						{ ...activity, event: "sync_started" },
					);
				} finally {
					this.#startingLocks.delete(target);
				}
			}
			return {
				...result,
				...this.syncState(target),
				instructions: syncMessage(target),
			};
		}
		if (this.#startingLocks.has(target))
			throw new Error("Synchronization is still starting; retry this action");
		if (!this.#locks.has(target))
			throw new Error("This Pi session is not synchronizing");
		const current = this.#state.code(target);
		if (!current)
			throw new Error("This Pi session has no synchronization code");
		if (code !== current) {
			await this.#notify(
				target,
				`${chatLabel(activity)} could not verify synchronization`,
				{ ...activity, event: "sync_rejected" },
			);
			throw new Error(
				`Invalid sync code. Ordinary tools remain locked. ${coordinationInstructions}`,
			);
		}
		if (action === "verify") {
			let renewed: string | undefined;
			if (!this.#locks.get(target)) {
				this.#locks.set(target, true);
				renewed = randomBytes(6).toString("hex");
				await this.#state.setCode(target, renewed);
				await this.#notify(
					target,
					`${chatLabel(activity)} verified synchronization`,
					{ ...activity, event: "sync_verified" },
				);
			}
			return {
				...result,
				...this.syncState(target),
				...(renewed ? { code: renewed } : {}),
				instructions:
					"You are the coordinator. Decide who continues, their tasks, and who exits; you may retain only one execution. Keep this code private. Release after your decisions are acknowledged and requested exits are complete.",
			};
		}
		if (!this.#locks.get(target))
			throw new Error(
				"Verify the initialization code before releasing synchronization",
			);
		this.#locks.delete(target);
		this.#notifyChange();
		await this.#notify(
			target,
			`${chatLabel(activity)} released synchronization`,
			{ ...activity, event: "sync_released" },
		);
		return {
			...result,
			...this.syncState(target),
			instructions:
				"Synchronization released. Continue as directed by the coordinator.",
		};
	}

	listSessions(sessionId?: string): (SessionDescription & {
		bindingCount: number;
		sync?: { locked: boolean; verified: boolean };
	})[] {
		const counts = this.#state.bindingCounts();
		return [...this.#sessions.values()]
			.filter(({ description }) => !sessionId || description.id === sessionId)
			.map(({ description }) => ({
				...description,
				bindingCount: counts.get(description.id) ?? 0,
				...(this.#sync ? { sync: this.syncState(description.id) } : {}),
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
			false,
			true,
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
			const inputs = this.deliveryAllowed(signal) ? result.inputs : [];
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
		if (!target || !this.#sessions.has(target) || !this.deliveryAllowed(signal))
			return [];
		const { inputs } = await this.#inspect(target, signal);
		if (!this.deliveryAllowed(signal)) return [];
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
		this.#requireUnlocked(chatId, target, signal);
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
		for (;;) {
			signal.throwIfAborted();
			const question = this.#state.question(chatId, id);
			this.#requireUnlocked(chatId, question.sessionId, signal);
			if (question.loaded) return questionView(question);
			await this.#waitForChange(signal);
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
		if (this.synchronizing(chatId)) return [];
		return this.#state
			.answers(chatId)
			.filter((question) => !this.#locks.has(question.sessionId));
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

	deliveries(chatId: string): DeliveryRecord[] {
		if (this.synchronizing(chatId)) return [];
		return this.#state
			.deliveries(chatId)
			.filter((delivery) => !this.#locks.has(delivery.sessionId));
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
		communication = false,
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
				target = [...this.#sessions.keys()].find(
					(id) => !occupied.has(id) && !this.#locks.has(id),
				);
			}
			if (!communication) this.#requireUnlocked(chatId, target, signal);
			if (!target) {
				await this.#waitForChange(signal);
				continue;
			}
			await this.#waitForSession(target, signal);
			signal.throwIfAborted();
			if (!communication) this.#requireUnlocked(chatId, target, signal);
			const current = this.#state.binding(chatId);
			const initialize =
				bindRequested ||
				!current ||
				(current === target && this.#sync && !this.#state.code(target));
			const initialization =
				initialize && !this.synchronizing(chatId, target)
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
		this.#requireUnlocked(chatId, sessionId, signal);
		const operation = this.#operations.get(signal);
		if (operation) this.#observe(operation, sessionId);
		const previous = this.#state.binding(chatId);
		const code = this.#sync ? randomBytes(6).toString("hex") : undefined;
		await this.#state.bind(chatId, sessionId);
		this.#requireUnlocked(chatId, sessionId, signal);
		if (code) {
			if (!operation)
				throw new Error(
					"Initialization is outside a tracked Chappie operation",
				);
			operation.initialization = {
				sessionId,
				code,
				previousCode: undefined,
				committed: false,
			};
		}
		const activity = source(chatId, requestId);
		if (previous !== sessionId) {
			this.#notifyChange();
			if (previous)
				await this.#notify(previous, `${chatLabel(activity)} left`, {
					...activity,
					event: "left",
				});
		}
		this.#requireUnlocked(chatId, sessionId, signal);
		await this.#notify(sessionId, `${chatLabel(activity)} joined`, {
			...activity,
			event: "joined",
			initialization: explicit ? "explicit" : "implicit",
		});
		const name = activity.requestId?.match(/\/([^/]+)$/)?.[1];
		const instructions = name
			? `${historyInstructions} Use this name when coordinating through chat.`
			: historyInstructions;
		return {
			sessionId,
			...(name ? { name } : {}),
			...(code ? { code } : {}),
			instructions: code
				? `${instructions} Keep this code private for sync verification.`
				: instructions,
		};
	}

	#requireUnlocked(
		chatId: string,
		sessionId: string | undefined,
		signal: AbortSignal,
	): void {
		signal.throwIfAborted();
		const operation = this.#operations.get(signal);
		if (operation) this.#observe(operation, sessionId);
		const locked = this.synchronizing(chatId, sessionId);
		if (locked) throw new Error(syncMessage(locked));
	}

	#observe(operation: Operation, sessionId: string | undefined): void {
		if (!sessionId) return;
		operation.sessionId ??= sessionId;
		if (!operation.revisions.has(sessionId)) {
			operation.revisions.set(
				sessionId,
				this.#syncRevisions.get(sessionId) ?? 0,
			);
		}
		if (this.#locks.has(sessionId)) operation.coordinating = true;
	}

	async #rollbackInitialization(operation: Operation): Promise<void> {
		const initialization = operation.initialization;
		if (!initialization?.committed) return;
		initialization.committed = false;
		await this.#state.setCode(
			initialization.sessionId,
			initialization.previousCode,
		);
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
		const operation = this.#operations.get(signal);
		if (operation) {
			this.#observe(operation, sessionId);
			if (!operation.communication)
				this.#requireUnlocked(operation.chatId, sessionId, signal);
		}
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

function syncMessage(sessionId: string): string {
	return `Pi session ${sessionId} is synchronizing. Ordinary tools and initialization are locked. Verify with your own initialization code; keep it private. ${coordinationInstructions} Only the verified coordinator can release.`;
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error(
				typeof signal.reason === "string" ? signal.reason : "Request cancelled",
			);
}
