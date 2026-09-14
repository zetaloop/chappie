import type { Context, UserMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type BrokerMessage,
	IpcClient,
	type SessionDescription,
	type SessionInspection,
	type SessionStatus,
} from "./ipc.ts";
import type { ProviderOutput } from "./provider.ts";

interface SyncRequest {
	resolve(): void;
	reject(error: Error): void;
}

export class LocalSession {
	readonly #pi: ExtensionAPI;
	readonly #agentDir: string;
	readonly #syncs = new Map<number, SyncRequest>();
	#context: ExtensionContext | undefined;
	#connection: IpcClient | undefined;
	#output: ProviderOutput | undefined;
	#providerContext: Context | undefined;
	#status: SessionStatus = "idle";
	#nextSyncId = 1;

	constructor(pi: ExtensionAPI, agentDir: string) {
		this.#pi = pi;
		this.#agentDir = agentDir;
	}

	install(): void {
		this.#pi.on("session_start", (_event, context) => this.#update(context));
		this.#pi.on("model_select", (event, context) =>
			this.#update(context, event.model.provider === "chappi"),
		);
		this.#pi.on("session_info_changed", (_event, context) => {
			this.#context = context;
			void this.#sync().catch(() => {});
		});
		this.#pi.on("session_shutdown", () => this.close());
	}

	async start(output: ProviderOutput, providerContext: Context): Promise<void> {
		const context = this.#context;
		const connection = this.#connection;
		if (context?.model?.provider !== "chappi" || !connection) {
			throw new Error("Chappi is not active for this session");
		}
		if (this.#output && !this.#output.closed) {
			throw new Error("Chappi already has an active provider request");
		}

		this.#output = output;
		this.#providerContext = providerContext;
		try {
			await connection.connect();
			if (output.closed) return;
			this.#status = "ready";
			await this.#sync();
			if (output.closed) return;
			output.begin();
			await output.finished;
		} finally {
			if (this.#output === output) this.#output = undefined;
			this.#status = "idle";
			void this.#sync().catch(() => {});
		}
	}

	close(): void {
		const sessionId = this.#context?.sessionManager.getSessionId();
		if (sessionId && this.#connection?.connected) {
			void this.#connection
				.send({ type: "unregister", sessionId })
				.catch(() => {});
		}
		this.#output?.fail(new Error("Chappi session ended"), true);
		this.#output = undefined;
		this.#providerContext = undefined;
		this.#connection?.close();
		this.#connection = undefined;
		this.#context = undefined;
		this.#rejectSyncs(new Error("Chappi session ended"));
	}

	#update(
		context: ExtensionContext,
		active = context.model?.provider === "chappi",
	): void {
		this.#context = context;
		if (!active) {
			this.close();
			return;
		}
		if (!this.#connection) {
			this.#connection = new IpcClient(this.#agentDir, {
				onOpen: () => this.#sync(),
				onMessage: (message) => this.#receive(message),
				onClose: (error) => {
					this.#rejectSyncs(error);
					this.#output?.fail(error);
				},
			});
			this.#connection.start();
		} else {
			void this.#sync().catch(() => {});
		}
	}

	#description(): SessionDescription {
		const context = this.#context;
		if (!context) throw new Error("Chappi session is not available");
		const name = this.#pi.getSessionName();
		const sessionFile = context.sessionManager.getSessionFile();
		return {
			id: context.sessionManager.getSessionId(),
			cwd: context.cwd,
			status: this.#status,
			...(name ? { name } : {}),
			...(sessionFile ? { sessionFile } : {}),
		};
	}

	async #sync(): Promise<void> {
		const connection = this.#connection;
		if (
			!connection?.connected ||
			!this.#context ||
			this.#context.model?.provider !== "chappi"
		)
			return;
		const id = this.#nextSyncId++;
		const completion = Promise.withResolvers<void>();
		this.#syncs.set(id, completion);
		try {
			await connection.send({ type: "sync", id, session: this.#description() });
			await completion.promise;
		} finally {
			this.#syncs.delete(id);
		}
	}

	async #receive(message: BrokerMessage): Promise<void> {
		switch (message.type) {
			case "synced":
				this.#syncs.get(message.id)?.resolve();
				break;
			case "inspect":
				try {
					if (
						message.sessionId !== this.#context?.sessionManager.getSessionId()
					) {
						throw new Error("The requested Pi session is no longer active");
					}
					await this.#connection?.send({
						type: "result",
						id: message.id,
						inspection: this.#inspection(),
					});
				} catch (error) {
					await this.#connection?.send({
						type: "result",
						id: message.id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				break;
		}
	}

	#inspection(): SessionInspection {
		const activeTools = new Set(this.#pi.getActiveTools());
		const input = this.#providerContext?.messages.findLast(
			(message): message is UserMessage => message.role === "user",
		);
		return {
			session: this.#description(),
			tools: this.#pi
				.getAllTools()
				.filter((tool) => activeTools.has(tool.name)),
			skills: this.#pi
				.getCommands()
				.filter((command) => command.source === "skill"),
			...(input ? { input } : {}),
		};
	}

	#rejectSyncs(error: Error): void {
		for (const sync of this.#syncs.values()) sync.reject(error);
		this.#syncs.clear();
	}
}
