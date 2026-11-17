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

export interface DeviceDescription {
	id: string;
	name: string;
	platform: string;
}

let identity: Promise<string> | undefined;

export class Client extends IpcClient {
	constructor(config: Config, callbacks: Partial<ConnectionCallbacks> = {}) {
		super(getDirectory(), config.connect, {
			onOpen: async () => {
				await this.send({ type: "client", device: await device() });
				await callbacks.onOpen?.();
			},
			onMessage: (message) => callbacks.onMessage?.(message),
			onClose: (error) => callbacks.onClose?.(error),
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
