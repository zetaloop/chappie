import {
	StdioServerTransport,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { Broker } from "./broker.ts";
import { getDirectory } from "./config.ts";
import { createServer } from "./server.ts";

const terminationSignals =
	process.platform === "win32"
		? ["SIGINT", "SIGTERM"]
		: ["SIGHUP", "SIGINT", "SIGTERM"];

export async function serve(): Promise<void> {
	const broker = new Broker(getDirectory());
	await broker.start();
	const output = process.stdout;
	const transport = new StdioServerTransport(process.stdin, output);
	let stop: (() => void) | undefined;
	const stopped = new Promise<void>((resolve) => {
		stop = resolve;
	});
	const requestStop = (): void => stop?.();

	output.once("error", requestStop);
	process.stdin.once("end", requestStop);
	process.stdin.once("close", requestStop);
	for (const signal of terminationSignals) {
		process.once(signal, requestStop);
	}

	const handle = serveStdio(() => createServer(broker), {
		transport,
		onerror(error) {
			console.error(error);
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") requestStop();
		},
	});

	try {
		await stopped;
		await handle.close();
	} finally {
		await broker.close();
	}
}
