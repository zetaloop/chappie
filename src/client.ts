import { randomUUID } from "node:crypto";
import {
	link,
	mkdir,
	mkdtempDisposable,
	readFile,
	writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { type Config, getDirectory } from "./config.ts";
import { type ConnectionCallbacks, IpcClient } from "./ipc.ts";
import { openTerminal } from "./launch.ts";

export interface DeviceDescription {
	id: string;
	name: string;
	platform: string;
}

let identity: Promise<string> | undefined;

export class Client extends IpcClient {
	handling = 0;

	constructor(
		config: Config,
		callbacks: Partial<ConnectionCallbacks> & { onActivity?(): void } = {},
	) {
		super(getDirectory(), config.connect, {
			onOpen: async () => {
				await this.send({ type: "client", device: await device() });
				await callbacks.onOpen?.();
			},
			onMessage: async (message) => {
				switch (message.type) {
					case "response":
					case "synced":
					case "stored":
					case "notice":
					case "ackInputs":
					case "launchDone":
					case "cancel":
						return callbacks.onMessage?.(message);
				}
				this.handling++;
				callbacks.onActivity?.();
				try {
					if (message.type !== "launch")
						return await callbacks.onMessage?.(message);
					try {
						await openTerminal(message, config);
					} catch (error) {
						await this.send({
							type: "launched",
							id: message.id,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				} finally {
					this.handling--;
					callbacks.onActivity?.();
				}
			},
			onClose: (error) => callbacks.onClose?.(error),
			onStatus: (status) => callbacks.onStatus?.(status),
		});
	}
}

async function device(): Promise<DeviceDescription> {
	identity ??= (async () => {
		const directory = getDirectory();
		const path = join(directory, "device.json");
		try {
			return z.string().parse(JSON.parse(await readFile(path, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await mkdir(directory, { recursive: true });
		await using temporary = await mkdtempDisposable(join(directory, "device-"));
		const source = join(temporary.path, "id");
		await writeFile(source, JSON.stringify(randomUUID()));
		try {
			await link(source, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		return z.string().parse(JSON.parse(await readFile(path, "utf8")));
	})();
	return { id: await identity, name: hostname(), platform: process.platform };
}
