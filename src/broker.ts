import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type BrokerMessage,
	IpcServer,
	type JsonLinePeer,
	type SessionDescription,
	type SessionInspection,
	type SessionMessage,
} from "./ipc.ts";
import { State } from "./state.ts";

interface RegisteredSession {
	description: SessionDescription;
	peer: JsonLinePeer<SessionMessage, BrokerMessage>;
}

interface PendingInspection {
	peer: JsonLinePeer<SessionMessage, BrokerMessage>;
	resolve(inspection: SessionInspection): void;
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
}

export class Broker {
	readonly #agentDir: string;
	readonly #ipc: IpcServer;
	readonly #state: State;
	readonly #sessions = new Map<string, RegisteredSession>();
	readonly #ready = new Set<string>();
	readonly #pending = new Map<number, PendingInspection>();
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
		const error = new Error("Chappi broker ended");
		for (const [id, pending] of this.#pending) {
			this.#finishInspection(id, pending);
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
		const target = await this.#selectSession(chatId, sessionId, signal);
		const inspection = await this.#inspect(target, signal);
		const globalAgents = await this.#readGlobalAgents();
		return { ...inspection, ...(globalAgents ? { globalAgents } : {}) };
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
			case "result": {
				const pending = this.#pending.get(message.id);
				if (!pending || pending.peer !== peer) break;
				this.#finishInspection(message.id, pending);
				if (message.error) pending.reject(new Error(message.error));
				else if (message.inspection) pending.resolve(message.inspection);
				else pending.reject(new Error("Pi session returned no inspection"));
				break;
			}
		}
	}

	async #selectSession(
		chatId: string,
		requestedId: string | undefined,
		signal: AbortSignal,
	): Promise<string> {
		const boundId = requestedId ?? this.#state.binding(chatId);
		if (boundId) {
			await this.#waitForSession(boundId, signal);
			if (this.#state.binding(chatId) !== boundId) {
				await this.#state.setBinding(chatId, boundId);
				this.#notifyChange();
			}
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
	): Promise<SessionInspection> {
		const session = this.#sessions.get(sessionId);
		if (!session) throw new Error(`Pi session ${sessionId} is offline`);
		const id = this.#nextRequestId++;
		const completion = Promise.withResolvers<SessionInspection>();
		const onAbort = (): void => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#finishInspection(id, pending);
			pending.reject(abortError(signal));
		};
		const pending: PendingInspection = {
			peer: session.peer,
			resolve: completion.resolve,
			reject: completion.reject,
			signal,
			onAbort,
		};
		if (signal.aborted) throw abortError(signal);
		this.#pending.set(id, pending);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await session.peer.send({ type: "inspect", id, sessionId });
		} catch (error) {
			this.#finishInspection(id, pending);
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

	#finishInspection(id: number, pending: PendingInspection): void {
		this.#pending.delete(id);
		pending.signal.removeEventListener("abort", pending.onAbort);
	}

	#removePeer(peer: JsonLinePeer<SessionMessage, BrokerMessage>): void {
		for (const [sessionId, session] of this.#sessions) {
			if (session.peer === peer) this.#removeSession(sessionId);
		}
		for (const [id, pending] of this.#pending) {
			if (pending.peer !== peer) continue;
			this.#finishInspection(id, pending);
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
