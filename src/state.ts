import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeliveryRecord } from "./delivery.ts";

interface StateFile {
	bindings?: Record<string, string>;
	deliveries?: DeliveryRecord[];
}

export class State {
	readonly #path: string;
	readonly #temporaryPath: string;
	readonly #bindings = new Map<string, string>();
	readonly #deliveries = new Map<string, DeliveryRecord>();
	#writes = Promise.resolve();

	constructor(agentDir: string) {
		this.#path = join(agentDir, "chappie.state.json");
		this.#temporaryPath = `${this.#path}.tmp`;
	}

	async load(): Promise<void> {
		let contents: string;
		try {
			contents = await readFile(this.#path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const state = JSON.parse(contents) as StateFile;
		for (const [chatId, sessionId] of Object.entries(state.bindings ?? {})) {
			if (typeof sessionId === "string") this.#bindings.set(chatId, sessionId);
		}
		for (const delivery of state.deliveries ?? []) {
			if (delivery?.id) this.#deliveries.set(delivery.id, delivery);
		}
	}

	binding(chatId: string): string | undefined {
		return this.#bindings.get(chatId);
	}

	chats(sessionId: string): string[] {
		return [...this.#bindings]
			.filter(([, target]) => target === sessionId)
			.map(([chatId]) => chatId);
	}

	bindingCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const sessionId of this.#bindings.values()) {
			counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
		}
		return counts;
	}

	setBinding(chatId: string, sessionId: string): Promise<void> {
		this.#bindings.set(chatId, sessionId);
		return this.#save();
	}

	deliveries(chatId: string): DeliveryRecord[] {
		return [...this.#deliveries.values()].filter(
			(delivery) => delivery.chatId === chatId,
		);
	}

	addDelivery(delivery: DeliveryRecord): Promise<void> {
		this.#deliveries.set(delivery.id, delivery);
		return this.#save();
	}

	removeDeliveries(ids: string[]): Promise<void> {
		for (const id of ids) this.#deliveries.delete(id);
		return this.#save();
	}

	async restoreDeliveries(deliveries: DeliveryRecord[]): Promise<void> {
		for (const delivery of deliveries)
			this.#deliveries.set(delivery.id, delivery);
		await this.#save();
	}

	#save(): Promise<void> {
		const saved = this.#writes.then(async () => {
			const bindings = Object.fromEntries(this.#bindings);
			await writeFile(
				this.#temporaryPath,
				`${JSON.stringify({ bindings, deliveries: [...this.#deliveries.values()] }, null, 2)}\n`,
				{
					mode: 0o600,
				},
			);
			await rename(this.#temporaryPath, this.#path);
		});
		this.#writes = saved.catch(() => {});
		return saved;
	}
}
