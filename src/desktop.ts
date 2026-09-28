import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

export interface DesktopMessage {
	type: string;
	method?: string;
	requestId?: string;
	sourceClientId?: string;
	handledByClientId?: string;
	resultType?: string;
	result?: unknown;
	error?: string;
	params?: Record<string, unknown>;
}

export class Desktop {
	readonly #receive: (message: DesktopMessage) => void;
	readonly #stopped = Promise.withResolvers<void>();
	readonly #pending = new Map<
		string,
		{ resolve(message: DesktopMessage): void; reject(error: Error): void }
	>();
	readonly #snapshots = new Map<
		string,
		Set<{
			owner: string;
			resolve(value: unknown): void;
			reject(error: Error): void;
		}>
	>();
	#socket: Socket | undefined;
	#length = 0;
	#clientId = "initializing-client";

	constructor(receive: (message: DesktopMessage) => void) {
		this.#receive = receive;
	}

	get closed(): Promise<void> {
		return this.#stopped.promise;
	}

	async connect(home: string): Promise<void> {
		const socket = connect(
			process.platform === "win32"
				? "\\\\.\\pipe\\codex-ipc"
				: join(home, "ipc", "ipc.sock"),
		);
		this.#socket = socket;
		socket.on("error", (error) => this.#ended(error));
		socket.once("close", () =>
			this.#ended(new Error("Codex desktop connection closed")),
		);
		socket.on("readable", () => {
			try {
				for (;;) {
					if (this.#length === 0) {
						const header = socket.read(4) as Buffer | null;
						if (!header) break;
						this.#length = header.readUInt32LE();
						if (this.#length === 0 || this.#length > 268_435_456)
							throw new Error(
								`Invalid Codex desktop frame length: ${this.#length}`,
							);
					}
					const body = socket.read(this.#length) as Buffer | null;
					if (!body) break;
					this.#length = 0;
					this.#message(JSON.parse(body.toString("utf8")) as DesktopMessage);
				}
			} catch (error) {
				socket.destroy(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		});
		await once(socket, "connect");
		const response = await this.request<{ clientId: string }>(
			"initialize",
			{ clientType: "chappie" },
			0,
		);
		this.#clientId = response.result.clientId;
	}

	async request<T>(
		method: string,
		params: Record<string, unknown>,
		version: number,
		owner?: string,
		timeoutMs = 10_000,
	): Promise<{ result: T; handledByClientId: string }> {
		const requestId = randomUUID();
		const pending = Promise.withResolvers<DesktopMessage>();
		const timer = setTimeout(
			() =>
				pending.reject(new Error(`Codex desktop request timed out: ${method}`)),
			timeoutMs,
		);
		this.#pending.set(requestId, pending);
		try {
			this.#send({
				type: "request",
				requestId,
				sourceClientId: this.#clientId,
				method,
				params,
				version,
				timeoutMs,
				...(owner ? { targetClientId: owner } : {}),
			});
			const message = await pending.promise;
			return {
				result: message.result as T,
				handledByClientId: message.handledByClientId as string,
			};
		} finally {
			clearTimeout(timer);
			this.#pending.delete(requestId);
		}
	}

	async owner(
		threadId: string,
		clientId?: string,
	): Promise<string | undefined> {
		try {
			const result = await this.request(
				"thread-owner-discovery",
				{ hostId: "local", conversationId: threadId },
				1,
				clientId,
			);
			return result.handledByClientId;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "no-client-found")
				return undefined;
			throw error;
		}
	}

	async snapshot<T>(threadId: string, owner: string): Promise<T> {
		const pending = { owner, ...Promise.withResolvers<unknown>() };
		const requests = this.#snapshots.get(threadId) ?? new Set();
		this.#snapshots.set(threadId, requests);
		requests.add(pending);
		const timer = setTimeout(
			() => pending.reject(new Error("Codex desktop snapshot timed out")),
			10_000,
		);
		try {
			this.#send({
				type: "broadcast",
				method: "thread-stream-following-changed",
				sourceClientId: this.#clientId,
				targetClientIds: [owner],
				version: 1,
				params: { hostId: "local", conversationId: threadId, following: true },
			});
			return (await pending.promise) as T;
		} finally {
			clearTimeout(timer);
			requests.delete(pending);
			if (requests.size === 0) this.#snapshots.delete(threadId);
		}
	}

	close(): void {
		this.#socket?.destroy();
		this.#ended(new Error("Codex desktop connection closed"));
	}

	#send(message: object): void {
		if (!this.#socket?.writable)
			throw new Error("Codex desktop is not connected");
		const body = Buffer.from(JSON.stringify(message));
		const size = Buffer.alloc(4);
		size.writeUInt32LE(body.length);
		this.#socket.write(Buffer.concat([size, body]));
	}

	#message(message: DesktopMessage): void {
		if (message.type === "client-discovery-request") {
			this.#send({
				type: "client-discovery-response",
				requestId: message.requestId,
				response: { canHandle: false },
			});
			return;
		}
		if (message.type === "response" && message.requestId) {
			const pending = this.#pending.get(message.requestId);
			if (message.resultType === "error")
				pending?.reject(
					Object.assign(new Error(message.error), { code: message.error }),
				);
			else pending?.resolve(message);
			return;
		}
		const params = message.params;
		if (message.method === "thread-stream-state-changed" && params) {
			const change = params.change as {
				type: string;
				conversationState?: unknown;
			};
			if (
				change.type === "snapshot" &&
				typeof params.conversationId === "string"
			)
				for (const pending of this.#snapshots.get(params.conversationId) ?? [])
					if (pending.owner === message.sourceClientId)
						pending.resolve(change.conversationState);
		}
		if (
			message.method === "client-status-changed" &&
			params?.status === "disconnected"
		)
			for (const requests of this.#snapshots.values())
				for (const pending of requests)
					if (pending.owner === params.clientId)
						pending.reject(
							new Error("Codex desktop session owner disconnected"),
						);
		this.#receive(message);
	}

	#ended(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		for (const requests of this.#snapshots.values())
			for (const pending of requests) pending.reject(error);
		this.#snapshots.clear();
		this.#stopped.resolve();
	}
}
