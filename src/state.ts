import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface StateFile {
	bindings?: Record<string, string>;
}

export class State {
	readonly #path: string;
	readonly #temporaryPath: string;
	readonly #bindings = new Map<string, string>();
	#writes = Promise.resolve();

	constructor(agentDir: string) {
		this.#path = join(agentDir, "chappi.state.json");
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
	}

	binding(chatId: string): string | undefined {
		return this.#bindings.get(chatId);
	}

	boundSessions(): Set<string> {
		return new Set(this.#bindings.values());
	}

	setBinding(chatId: string, sessionId: string): Promise<void> {
		this.#bindings.set(chatId, sessionId);
		const saved = this.#writes.then(async () => {
			const bindings = Object.fromEntries(this.#bindings);
			await writeFile(
				this.#temporaryPath,
				`${JSON.stringify({ bindings }, null, 2)}\n`,
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
