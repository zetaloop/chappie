import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { getDirectory } from "./config.ts";
import { IpcClient } from "./ipc.ts";
import { type LaunchJob, startAgent } from "./launch.ts";

const file = process.argv[2];
if (!file) throw new Error("Missing launch request");
const job = JSON.parse(await readFile(file, "utf8")) as LaunchJob;
await rm(file);
process.env[process.platform === "win32" ? "USERPROFILE" : "HOME"] = job.home;
let launching = true;
const client = new IpcClient(getDirectory(), job.config.connect, {
	onOpen: () => client.send({ type: "launching", id: job.id }),
	onMessage: (message) => {
		if (message.type !== "launchDone" || message.id !== job.id) return;
		launching = false;
		client.close();
	},
	onClose: () => {
		launching = false;
		client.close();
	},
});
try {
	await client.connect();
	process.chdir(job.cwd);
	const { code, signal } = await startAgent(job, dirname(file), (sessionId) =>
		client.send({ type: "launched", id: job.id, sessionId }),
	);
	process.exitCode = code ?? 1;
	if (launching)
		throw new Error(
			`${job.agent} exited (${signal ?? code}) before connecting to Chappie`,
		);
} catch (error) {
	console.error(error);
	if (client.connected)
		await client
			.send({
				type: "launched",
				id: job.id,
				error: error instanceof Error ? error.message : String(error),
			})
			.catch(() => {});
	process.exitCode = 1;
} finally {
	client.close();
	await rm(dirname(file), { recursive: true, force: true });
}
