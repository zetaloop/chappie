import { addAbortListener } from "node:events";
import { createInterface } from "node:readline";
import { Duplex, Readable, Writable } from "node:stream";
import { spawn } from "cross-spawn";
import WebSocket from "ws";
import packageJson from "../package.json" with { type: "json" };

export interface RpcMessage {
	id?: string | number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export class AppServer {
	readonly #pending = new Map<
		number,
		{
			resolve(value: unknown): void;
			reject(error: Error): void;
		}
	>();
	readonly #receive: (message: RpcMessage) => void;
	readonly #stopped = Promise.withResolvers<void>();
	#send: ((message: RpcMessage) => void) | undefined;
	#close: (() => void) | undefined;
	#nextId = 1;

	constructor(receive: (message: RpcMessage) => void) {
		this.#receive = receive;
	}

	static async query<T>(
		method: string,
		params: Record<string, unknown> = {},
		signal?: AbortSignal,
	): Promise<T> {
		signal?.throwIfAborted();
		const child = spawn("codex", ["app-server"], {
			stdio: ["pipe", "pipe", "inherit"],
			signal,
		});
		const rpc = new AppServer(() => {});
		const reader = createInterface({ input: child.stdout });
		reader.on("line", (line) => rpc.#message(line));
		reader.on("error", (error) => rpc.#ended(error));
		child.on("error", (error) => rpc.#ended(error));
		child.stdin.on("error", (error) => rpc.#ended(error));
		child.once("exit", () =>
			rpc.#ended(new Error("Codex query process exited")),
		);
		rpc.#send = (message) => {
			child.stdin.write(`${JSON.stringify(message)}\n`);
		};
		try {
			await rpc.#initialize();
			return await rpc.request<T>(method, params);
		} finally {
			reader.close();
			if (!child.killed) child.kill();
		}
	}

	get closed(): Promise<void> {
		return this.#stopped.promise;
	}

	async connect(address = "unix://"): Promise<void> {
		let stream: Duplex | undefined;
		if (address.startsWith("unix://")) {
			const path = address.slice("unix://".length);
			const child = spawn(
				"codex",
				["app-server", "proxy", ...(path ? ["--sock", path] : [])],
				{
					stdio: ["pipe", "pipe", "inherit"],
				},
			);
			const transport = Duplex.fromWeb({
				readable: Readable.toWeb(child.stdout),
				writable: Writable.toWeb(child.stdin),
			});
			child.on("error", (error) => transport.destroy(error));
			child.on("exit", (code) =>
				transport.destroy(
					code ? new Error(`Codex proxy exited (${code})`) : undefined,
				),
			);
			transport.on("close", () => child.kill());
			stream = transport;
		}
		const socket = stream
			? new WebSocket("ws://localhost", { createConnection: () => stream })
			: new WebSocket(address);
		const ready = Promise.withResolvers<void>();
		socket.once("open", () => ready.resolve());
		socket.on("error", (error) => {
			ready.reject(error);
			this.#ended(error);
		});
		socket.once("close", () => {
			stream?.destroy();
			const error = new Error("Codex app-server connection closed");
			ready.reject(error);
			this.#ended(error);
		});
		socket.on("message", (data) => this.#message(data.toString()));
		this.#close = () => {
			socket.terminate();
			stream?.destroy();
		};
		try {
			await ready.promise;
			this.#send = (message) => socket.send(JSON.stringify(message));
			await this.#initialize();
		} catch (error) {
			this.close();
			throw error;
		}
	}

	async #initialize(): Promise<void> {
		await this.request("initialize", {
			clientInfo: { name: "chappie", version: packageJson.version },
			capabilities: { experimentalApi: true },
		});
		this.#send?.({ method: "initialized" });
	}

	async request<T>(
		method: string,
		params: Record<string, unknown> = {},
		signal?: AbortSignal,
	): Promise<T> {
		signal?.throwIfAborted();
		if (!this.#send) throw new Error("Codex app-server is not connected");
		const id = this.#nextId++;
		const completion = Promise.withResolvers<unknown>();
		this.#pending.set(id, completion);
		using _listener = signal
			? addAbortListener(signal, () => completion.reject(signal.reason))
			: undefined;
		try {
			this.#send({ id, method, params });
			return (await completion.promise) as T;
		} finally {
			this.#pending.delete(id);
		}
	}

	close(): void {
		this.#close?.();
		this.#ended(new Error("Codex app-server connection closed"));
	}

	#message(text: string): void {
		let message: RpcMessage;
		try {
			message = JSON.parse(text) as RpcMessage;
		} catch (error) {
			this.#ended(error instanceof Error ? error : new Error(String(error)));
			this.#close?.();
			return;
		}
		if (message.method) {
			this.#receive(message);
			return;
		}
		if (typeof message.id !== "number") return;
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		if (message.error) pending.reject(new Error(message.error.message));
		else pending.resolve(message.result);
	}

	#ended(error: Error): void {
		this.#send = undefined;
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		this.#stopped.resolve();
	}
}
