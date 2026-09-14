import { createHash } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net";
import { join, resolve } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import type {
	SlashCommandInfo,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";

export type SessionStatus = "idle" | "ready" | "executing";

export interface SessionDescription {
	id: string;
	cwd: string;
	name?: string;
	sessionFile?: string;
	status: SessionStatus;
}

export interface SessionInspection {
	session: SessionDescription;
	tools: ToolInfo[];
	skills: SlashCommandInfo[];
	input?: UserMessage;
}

export type SessionMessage =
	| { type: "sync"; id: number; session: SessionDescription }
	| { type: "unregister"; sessionId: string }
	| {
			type: "result";
			id: number;
			inspection?: SessionInspection;
			error?: string;
	  };

export type BrokerMessage =
	| { type: "synced"; id: number; sessionId: string }
	| { type: "inspect"; id: number; sessionId: string };

export function ipcEndpoint(agentDir: string): string {
	const directory = resolve(agentDir);
	if (process.platform !== "win32") return join(directory, "chappi.sock");
	const identity = directory.replaceAll("\\", "/").toLowerCase();
	return String.raw`\\.\pipe\chappi-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

export class JsonLinePeer<Incoming, Outgoing> {
	readonly #socket: Socket;
	readonly #onMessage: (message: Incoming) => Promise<void> | void;
	readonly #onClose: () => void;
	#buffer = "";
	#messages = Promise.resolve();
	#writes = Promise.resolve();
	#closed = false;

	constructor(
		socket: Socket,
		onMessage: (message: Incoming) => Promise<void> | void,
		onClose: () => void,
	) {
		this.#socket = socket;
		this.#onMessage = onMessage;
		this.#onClose = onClose;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.#receive(chunk));
		socket.once("close", () => {
			this.#closed = true;
			this.#onClose();
		});
		socket.on("error", () => {});
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(message: Outgoing): Promise<void> {
		const line = `${JSON.stringify(message)}\n`;
		const sent = this.#writes.then(
			() =>
				new Promise<void>((resolveWrite, rejectWrite) => {
					if (this.#closed) {
						rejectWrite(new Error("Chappi IPC connection is closed"));
						return;
					}
					this.#socket.write(line, (error) => {
						if (error) rejectWrite(error);
						else resolveWrite();
					});
				}),
		);
		this.#writes = sent.catch(() => {});
		return sent;
	}

	close(): void {
		if (!this.#closed) this.#socket.end();
	}

	#receive(chunk: string): void {
		this.#buffer += chunk;
		let end = this.#buffer.indexOf("\n");
		while (end !== -1) {
			const line = this.#buffer.slice(0, end);
			this.#buffer = this.#buffer.slice(end + 1);
			if (line.length > 0) {
				this.#messages = this.#messages
					.then(() => this.#onMessage(JSON.parse(line) as Incoming))
					.catch((error: unknown) => {
						this.#socket.destroy(
							error instanceof Error ? error : new Error(String(error)),
						);
					});
			}
			end = this.#buffer.indexOf("\n");
		}
	}
}

export class IpcServer {
	readonly #endpoint: string;
	readonly #onMessage: (
		peer: JsonLinePeer<SessionMessage, BrokerMessage>,
		message: SessionMessage,
	) => Promise<void> | void;
	readonly #onClose: (
		peer: JsonLinePeer<SessionMessage, BrokerMessage>,
	) => void;
	readonly #peers = new Set<JsonLinePeer<SessionMessage, BrokerMessage>>();
	#server: Server | undefined;

	constructor(
		agentDir: string,
		onMessage: (
			peer: JsonLinePeer<SessionMessage, BrokerMessage>,
			message: SessionMessage,
		) => Promise<void> | void,
		onClose: (peer: JsonLinePeer<SessionMessage, BrokerMessage>) => void,
	) {
		this.#endpoint = ipcEndpoint(agentDir);
		this.#onMessage = onMessage;
		this.#onClose = onClose;
	}

	async start(): Promise<void> {
		if (this.#server) return;
		if (process.platform !== "win32") await prepareUnixSocket(this.#endpoint);
		const server = createServer((socket) => {
			let peer: JsonLinePeer<SessionMessage, BrokerMessage>;
			peer = new JsonLinePeer(
				socket,
				(message) => this.#onMessage(peer, message),
				() => {
					this.#peers.delete(peer);
					this.#onClose(peer);
				},
			);
			this.#peers.add(peer);
		});
		await new Promise<void>((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(this.#endpoint, () => {
				server.off("error", rejectListen);
				resolveListen();
			});
		});
		this.#server = server;
	}

	async close(): Promise<void> {
		for (const peer of this.#peers) peer.close();
		this.#peers.clear();
		const server = this.#server;
		this.#server = undefined;
		if (!server) return;
		await new Promise<void>((resolveClose, rejectClose) =>
			server.close((error) => (error ? rejectClose(error) : resolveClose())),
		);
	}
}

interface ConnectionCallbacks {
	onOpen(): Promise<void> | void;
	onMessage(message: BrokerMessage): Promise<void> | void;
	onClose(error: Error): void;
}

export class IpcClient {
	readonly #endpoint: string;
	readonly #callbacks: ConnectionCallbacks;
	#peer: JsonLinePeer<BrokerMessage, SessionMessage> | undefined;
	#opening: Promise<void> | undefined;
	#retry: NodeJS.Timeout | undefined;
	#closed = false;

	constructor(agentDir: string, callbacks: ConnectionCallbacks) {
		this.#endpoint = ipcEndpoint(agentDir);
		this.#callbacks = callbacks;
	}

	get connected(): boolean {
		return this.#peer !== undefined && !this.#peer.closed;
	}

	start(): void {
		void this.connect().catch(() => {});
	}

	connect(): Promise<void> {
		if (this.#closed)
			return Promise.reject(new Error("Chappi IPC client is closed"));
		if (this.connected) return Promise.resolve();
		if (this.#opening) return this.#opening;
		clearTimeout(this.#retry);
		this.#retry = undefined;
		this.#opening = this.#open().finally(() => {
			this.#opening = undefined;
		});
		return this.#opening;
	}

	send(message: SessionMessage): Promise<void> {
		const peer = this.#peer;
		if (!peer || peer.closed)
			return Promise.reject(new Error("Chappi broker is not running"));
		return peer.send(message);
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#retry);
		this.#retry = undefined;
		this.#peer?.close();
		this.#peer = undefined;
	}

	async #open(): Promise<void> {
		const socket = createConnection(this.#endpoint);
		let failure = new Error("Chappi broker connection ended");
		await new Promise<void>((resolveOpen, rejectOpen) => {
			socket.once("connect", resolveOpen);
			socket.once("error", (error) => {
				failure = error;
				rejectOpen(error);
			});
		}).catch((error: unknown) => {
			socket.destroy();
			this.#scheduleReconnect();
			throw error;
		});

		let peer: JsonLinePeer<BrokerMessage, SessionMessage>;
		peer = new JsonLinePeer(
			socket,
			(message) => this.#callbacks.onMessage(message),
			() => {
				if (this.#peer !== peer) return;
				this.#peer = undefined;
				if (!this.#closed) {
					this.#callbacks.onClose(failure);
					this.#scheduleReconnect();
				}
			},
		);
		this.#peer = peer;
		try {
			await this.#callbacks.onOpen();
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
			peer.close();
			throw failure;
		}
	}

	#scheduleReconnect(): void {
		if (this.#closed || this.#retry) return;
		this.#retry = setTimeout(() => {
			this.#retry = undefined;
			void this.connect().catch(() => {});
		}, 500);
		this.#retry.unref();
	}
}

async function prepareUnixSocket(endpoint: string): Promise<void> {
	try {
		await lstat(endpoint);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}

	if (await endpointAcceptsConnections(endpoint)) {
		const error = new Error(
			`Chappi broker is already listening at ${endpoint}`,
		) as NodeJS.ErrnoException;
		error.code = "EADDRINUSE";
		throw error;
	}
	await unlink(endpoint);
}

function endpointAcceptsConnections(endpoint: string): Promise<boolean> {
	return new Promise<boolean>((resolveProbe, rejectProbe) => {
		const socket = createConnection(endpoint);
		socket.once("connect", () => {
			socket.end();
			resolveProbe(true);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			socket.destroy();
			if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
				resolveProbe(false);
			else rejectProbe(error);
		});
	});
}
