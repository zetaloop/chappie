import { spawn } from "node:child_process";
import { Duplex, Readable, Writable } from "node:stream";
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
		await ready.promise;
		this.#send = (message) => socket.send(JSON.stringify(message));
		await this.request("initialize", {
			clientInfo: { name: "chappie", version: packageJson.version },
			capabilities: { experimentalApi: true },
		});
		this.#send?.({ method: "initialized" });
	}

	request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		if (!this.#send)
			return Promise.reject(new Error("Codex app-server is not connected"));
		const id = this.#nextId++;
		const completion = Promise.withResolvers<unknown>();
		this.#pending.set(id, completion);
		try {
			this.#send({ id, method, params });
		} catch (error) {
			this.#pending.delete(id);
			completion.reject(error);
		}
		return completion.promise as Promise<T>;
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
		this.#pending.delete(message.id);
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
