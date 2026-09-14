import { createWriteStream } from "node:fs";
import {
	StdioServerTransport,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.ts";

const terminationSignals =
	process.platform === "win32"
		? ["SIGINT", "SIGTERM"]
		: ["SIGHUP", "SIGINT", "SIGTERM"];

export async function serveChappi(): Promise<never> {
	const output = createWriteStream("", { fd: 1, autoClose: false });
	const transport = new StdioServerTransport(process.stdin, output);
	let stop: (() => void) | undefined;
	const stopped = new Promise<void>((resolve) => {
		stop = resolve;
	});
	const requestStop = (): void => stop?.();

	process.stdin.once("end", requestStop);
	process.stdin.once("close", requestStop);
	for (const signal of terminationSignals) {
		process.once(signal, requestStop);
	}

	const handle = serveStdio(() => createServer(), {
		transport,
		onerror(error) {
			console.error(error);
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") requestStop();
		},
	});

	await stopped;
	await handle.close();
	await new Promise<void>((resolve) => output.end(resolve));
	process.exit(0);
}
