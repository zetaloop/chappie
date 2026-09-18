import { createHash } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net";
import { join, resolve } from "node:path";
import type {
	AssistantMessage,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	SlashCommandInfo,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { Activity } from "./activity.ts";
import type { DeliveryRecord } from "./delivery.ts";
import type { HistoryRange, HistoryResult } from "./history.ts";
import type { ResourceData, ResourceDescriptor } from "./resources.ts";
import type { TransferDetails } from "./transfer.ts";

const defaultPort = 24274;

export type SessionStatus = "idle" | "ready" | "executing";

export interface SessionDescription {
	id: string;
	cwd: string;
	device: string;
	name?: string;
	status: SessionStatus;
}

export interface SessionInspection {
	session: SessionDescription;
	tools: ToolInfo[];
	skills: SlashCommandInfo[];
}

export interface SessionInput {
	id: string;
	sessionId: string;
	message: UserMessage;
}

export type SessionResult =
	| {
			inspection: SessionInspection;
			inputs: SessionInput[];
			globalAgents?: { path: string };
	  }
	| { message: AssistantMessage; cwd: string; inputs: SessionInput[] }
	| {
			message: AssistantMessage;
			cwd: string;
			toolResults: ToolResultMessage[];
			inputs: SessionInput[];
	  }
	| { history: HistoryResult; cwd: string }
	| { resource: ResourceData }
	| { transfer: TransferDetails }
	| { error: string };

export type SessionRequest =
	| { type: "inspect"; sessionId: string }
	| { type: "readResource"; sessionId: string; uri: string; offset?: number }
	| {
			type: "copy";
			sessionId: string;
			resources: ResourceDescriptor[];
			paths: string[];
			overwrite?: boolean;
	  };

export type SessionMessage =
	| { type: "sync"; id: number; session: SessionDescription }
	| { type: "unregister"; sessionId: string }
	| { type: "delivery"; delivery: DeliveryRecord }
	| { type: "request"; id: number; request: SessionRequest }
	| { type: "cancelRequest"; id: number }
	| ({ type: "result"; id: number } & SessionResult);

export type BrokerMessage =
	| { type: "synced"; id: number; sessionId: string }
	| { type: "stored"; id: string }
	| { type: "notice"; sessionId: string; message: string; activity?: Activity }
	| {
			type: "history";
			id: number;
			sessionId: string;
			range: HistoryRange;
			chatId: string;
			requestId?: string;
	  }
	| {
			type: "chat";
			id: number;
			chatId: string;
			requestId?: string;
			sessionId: string;
			text: string;
	  }
	| {
			type: "call";
			id: number;
			chatId: string;
			requestId?: string;
			sessionId: string;
			calls: ToolCall[];
	  }
	| { type: "cancel"; id: number; sessionId: string; reason: string }
	| (SessionRequest & { id: number })
	| ({ type: "response"; id: number } & SessionResult)
	| { type: "ackInputs"; sessionId: string; ids: string[] };

export function ipcEndpoint(agentDir: string): string {
	const directory = resolve(agentDir);
	if (process.platform !== "win32") return join(directory, "chappie.sock");
	const identity = directory.replaceAll("\\", "/").toLowerCase();
	return String.raw`\\.\pipe\chappie-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
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
						rejectWrite(new Error("Chappie IPC connection is closed"));
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
	readonly #servers = new Set<Server>();

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

	async start(network: boolean | number = false): Promise<void> {
		if (this.#servers.size > 0) return;
		if (process.platform !== "win32") await prepareUnixSocket(this.#endpoint);
		try {
			const local = this.#createServer();
			await listenServer(local, this.#endpoint);
			this.#servers.add(local);
			if (!network) return;

			const remote = this.#createServer();
			await listenServer(remote, network === true ? defaultPort : network);
			this.#servers.add(remote);
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		for (const peer of this.#peers) peer.close();
		this.#peers.clear();
		const servers = [...this.#servers];
		this.#servers.clear();
		await Promise.all(servers.map(closeServer));
	}

	#createServer(): Server {
		return createServer((socket) => {
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
	}
}

interface ConnectionCallbacks {
	onOpen(): Promise<void> | void;
	onMessage(message: BrokerMessage): Promise<void> | void;
	onClose(error: Error): void;
}

export class IpcClient {
	readonly #endpoint: string;
	readonly #remote: string | undefined;
	readonly #callbacks: ConnectionCallbacks;
	#peer: JsonLinePeer<BrokerMessage, SessionMessage> | undefined;
	#opening: Promise<void> | undefined;
	#controller: AbortController | undefined;
	#retry: NodeJS.Timeout | undefined;
	#closed = false;

	constructor(
		agentDir: string,
		remote: string | undefined,
		callbacks: ConnectionCallbacks,
	) {
		this.#endpoint = ipcEndpoint(agentDir);
		this.#remote = remote;
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
			return Promise.reject(new Error("Chappie IPC client is closed"));
		if (this.connected) return Promise.resolve();
		if (this.#opening) return this.#opening;
		clearTimeout(this.#retry);
		this.#retry = undefined;
		const controller = new AbortController();
		this.#controller = controller;
		this.#opening = this.#open(controller.signal).finally(() => {
			this.#opening = undefined;
			if (this.#controller === controller) this.#controller = undefined;
		});
		return this.#opening;
	}

	send(message: SessionMessage): Promise<void> {
		const peer = this.#peer;
		if (!peer || peer.closed)
			return Promise.reject(new Error("Chappie broker is not running"));
		return peer.send(message);
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#retry);
		this.#retry = undefined;
		this.#controller?.abort(new Error("Chappie IPC client is closed"));
		this.#controller = undefined;
		this.#peer?.close();
		this.#peer = undefined;
	}

	async #open(signal: AbortSignal): Promise<void> {
		let socket: Socket | undefined;
		let failure = new Error("Chappie disconnected");
		try {
			socket = this.#remote
				? createConnection(networkEndpoint(this.#remote))
				: createConnection(this.#endpoint);
			await connectSocket(socket, signal);
		} catch (error) {
			socket?.destroy();
			this.#scheduleReconnect();
			throw error;
		}

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

function listenServer(
	server: Server,
	endpoint: string | number,
): Promise<void> {
	return new Promise<void>((resolveListen, rejectListen) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			rejectListen(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolveListen();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(endpoint);
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise<void>((resolveClose, rejectClose) =>
		server.close((error) => (error ? rejectClose(error) : resolveClose())),
	);
}

interface NetworkEndpoint {
	host: string;
	port: number;
}

function networkEndpoint(value: string): NetworkEndpoint {
	const url = new URL(`tcp://${value}`);
	if (url.username || url.password || url.pathname || url.search || url.hash)
		throw new Error(`Invalid Chappie broker address: ${value}`);
	const host = url.hostname.startsWith("[")
		? url.hostname.slice(1, -1)
		: url.hostname;
	if (!host) throw new Error(`Invalid Chappie broker address: ${value}`);
	return { host, port: url.port ? Number(url.port) : defaultPort };
}

function connectSocket(socket: Socket, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolveConnect, rejectConnect) => {
		const cleanup = (): void => {
			signal.removeEventListener("abort", onAbort);
			socket.off("connect", onConnect);
			socket.off("error", onError);
		};
		const onConnect = (): void => {
			cleanup();
			resolveConnect();
		};
		const onError = (error: Error): void => {
			cleanup();
			rejectConnect(error);
		};
		const onAbort = (): void => {
			cleanup();
			socket.destroy();
			rejectConnect(abortError(signal));
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error(
				typeof signal.reason === "string" ? signal.reason : "Request cancelled",
			);
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
			`Chappie broker is already listening at ${endpoint}`,
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
