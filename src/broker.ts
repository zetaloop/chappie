import {
	type BrokerMessage,
	IpcServer,
	type JsonLinePeer,
	type SessionDescription,
	type SessionMessage,
} from "./ipc.ts";

interface RegisteredSession {
	description: SessionDescription;
	peer: JsonLinePeer<SessionMessage, BrokerMessage>;
}

export class Broker {
	readonly #ipc: IpcServer;
	readonly #sessions = new Map<string, RegisteredSession>();

	constructor(agentDir: string) {
		this.#ipc = new IpcServer(
			agentDir,
			(peer, message) => this.#receive(peer, message),
			(peer) => this.#removePeer(peer),
		);
	}

	start(): Promise<void> {
		return this.#ipc.start();
	}

	async close(): Promise<void> {
		this.#sessions.clear();
		await this.#ipc.close();
	}

	listSessions(): SessionDescription[] {
		return [...this.#sessions.values()].map(({ description }) => description);
	}

	async #receive(
		peer: JsonLinePeer<SessionMessage, BrokerMessage>,
		message: SessionMessage,
	): Promise<void> {
		switch (message.type) {
			case "sync":
				this.#sessions.set(message.session.id, {
					description: message.session,
					peer,
				});
				await peer.send({
					type: "synced",
					id: message.id,
					sessionId: message.session.id,
				});
				break;
			case "unregister": {
				const session = this.#sessions.get(message.sessionId);
				if (session?.peer === peer) this.#sessions.delete(message.sessionId);
				break;
			}
		}
	}

	#removePeer(peer: JsonLinePeer<SessionMessage, BrokerMessage>): void {
		for (const [sessionId, session] of this.#sessions) {
			if (session.peer === peer) this.#sessions.delete(sessionId);
		}
	}
}
