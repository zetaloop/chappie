import {
	StdioServerTransport,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { Broker } from "./broker.ts";
import { Client } from "./client.ts";
import { getDirectory, readConfig } from "./config.ts";
import { createServer } from "./server.ts";

const terminationSignals =
	process.platform === "win32"
		? ["SIGINT", "SIGTERM"]
		: ["SIGHUP", "SIGINT", "SIGTERM"];

export async function serve(): Promise<void> {
	const config = await readConfig();
	const broker = config.connect ? undefined : new Broker(getDirectory());
	const client = new Client(config, {
		onClose: (error) => console.error(error.message),
	});
	let stop: (() => void) | undefined;
	const stopped = new Promise<void>((resolve) => {
		stop = resolve;
	});
	const requestStop = (): void => stop?.();

	for (const signal of terminationSignals) {
		process.once(signal, requestStop);
	}

	try {
		if (!broker) {
			client.start(true);
			await stopped;
			return;
		}
		await broker.start();
		await client.connect();
		const output = process.stdout;
		const transport = new StdioServerTransport(process.stdin, output);
		output.once("error", requestStop);
		process.stdin.once("end", requestStop);
		process.stdin.once("close", requestStop);
		const handle = serveStdio(() => createServer(broker), {
			transport,
			onerror(error) {
				console.error(error);
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") requestStop();
			},
		});
		await stopped;
		await handle.close();
	} finally {
		client.close();
		await broker?.close();
	}
}
