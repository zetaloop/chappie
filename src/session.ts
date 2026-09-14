import type { Context } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type BrokerMessage,
	IpcClient,
	type SessionDescription,
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

	async start(
		output: ProviderOutput,
		_providerContext: Context,
	): Promise<void> {
		const context = this.#context;
		const connection = this.#connection;
		if (context?.model?.provider !== "chappi" || !connection) {
			throw new Error("Chappi is not active for this session");
		}
		if (this.#output && !this.#output.closed) {
			throw new Error("Chappi already has an active provider request");
		}

		this.#output = output;
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

	#receive(message: BrokerMessage): void {
		if (message.type !== "synced") return;
		this.#syncs.get(message.id)?.resolve();
	}

	#rejectSyncs(error: Error): void {
		for (const sync of this.#syncs.values()) sync.reject(error);
		this.#syncs.clear();
	}
}
