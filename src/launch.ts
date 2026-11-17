import type { SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "cross-spawn";
import * as z from "zod";
import type { AppServer } from "./appserver.ts";
import type { Config } from "./config.ts";

export const launchInput = z.object({
	device: z.string().min(1).describe("Device ID from the devices array"),
	agent: z
		.enum(["pi", "omp", "opencode", "codex"])
		.describe(
			"Agent requested by the user or established by the task; ask when unclear",
		),
	cwd: z
		.string()
		.min(1)
		.describe("Working directory; relative paths start at the device's home"),
});

export const launchDescription =
	"Launch a session in a new terminal at the user's request or with their agreement.";

export type LaunchInput = z.infer<typeof launchInput>;

export interface LaunchRequest {
	id: string;
	agent: LaunchInput["agent"];
	cwd: string;
}

export interface LaunchJob extends LaunchRequest {
	config: Config;
	home: string;
}

export async function openTerminal(
	request: LaunchRequest,
	config: Config,
): Promise<void> {
	const path = request.cwd;
	const cwd = await realpath(
		resolve(
			homedir(),
			path === "~" ? "." : path.startsWith("~/") ? path.slice(2) : path,
		),
	);
	if (!(await stat(cwd)).isDirectory())
		throw new Error(`Not a directory: ${cwd}`);
	const node = (await run("node", ["-p", "process.execPath"])).trim();
	const entry = fileURLToPath(new URL("./terminal.js", import.meta.url));
	const directory = await mkdtemp(join(tmpdir(), "chappie-"));
	const file = join(directory, "launch.json");
	try {
		const job: LaunchJob = { ...request, cwd, config, home: homedir() };
		await writeFile(file, JSON.stringify(job), { mode: 0o600 });
		switch (process.platform) {
			case "darwin": {
				const script = join(directory, "launch.command");
				const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
				await writeFile(
					script,
					`#!/bin/sh\nexec ${[node, entry, file].map(quote).join(" ")}\n`,
					{ mode: 0o700 },
				);
				await run("open", [script]);
				break;
			}
			case "win32":
				await run(
					process.env.ComSpec ?? "cmd.exe",
					[
						"/d",
						"/s",
						"/c",
						'start "" "%CHAPPIE_NODE%" "%CHAPPIE_TERMINAL%" "%CHAPPIE_JOB%"',
					],
					{
						env: {
							...process.env,
							CHAPPIE_NODE: node,
							CHAPPIE_TERMINAL: entry,
							CHAPPIE_JOB: file,
						},
						stdio: "ignore",
						windowsVerbatimArguments: true,
					},
				);
				break;
			default:
				await run("xdg-terminal-exec", [node, entry, file], {
					stdio: "ignore",
					detached: true,
				});
				break;
		}
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

export async function startAgent(
	job: LaunchJob,
	directory: string,
	launched: (sessionId: string) => Promise<void>,
) {
	let args: string[];
	let env = process.env;
	let rpc: AppServer | undefined;
	let sessionId: string | undefined;
	try {
		switch (job.agent) {
			case "pi":
				args = ["--model", "chappie/remote"];
				break;
			case "omp": {
				const config = join(directory, "omp.json");
				await writeFile(config, '{"autoResume":false}');
				args = ["--model", "chappie/remote", "--config", config];
				break;
			}
			case "opencode": {
				const endpoint = job.config.opencode;
				const server = endpoint ? ["--server", endpoint.url] : [];
				if (endpoint?.password)
					env = { ...env, OPENCODE_PASSWORD: endpoint.password };
				const { data: session } = JSON.parse(
					await run(
						"opencode",
						[
							...server,
							"api",
							"session.create",
							"--data",
							JSON.stringify({
								location: { directory: job.cwd },
								model: { providerID: "chappie", id: "remote" },
							}),
						],
						{ env },
					),
				) as { data: { id: string } };
				sessionId = session.id;
				args = [...server, "--session", sessionId];
				break;
			}
			case "codex": {
				const { AppServer } = await import("./appserver.ts");
				const { setupCodex } = await import("./codex-plugin.ts");
				const catalog = await setupCodex();
				if (!job.config.codex?.appServer)
					await run("codex", ["app-server", "daemon", "start"], {
						stdio: "inherit",
					});
				const address = job.config.codex?.appServer ?? "unix://";
				rpc = new AppServer(() => {});
				await rpc.connect(address);
				const { thread } = await rpc.request<{ thread: { id: string } }>(
					"thread/start",
					{
						cwd: job.cwd,
						modelProvider: "chappie",
						model: "remote",
						config: { model_catalog_json: catalog },
					},
				);
				sessionId = thread.id;
				args = ["--remote", address, "resume", sessionId];
				break;
			}
			default:
				throw new Error(`Unknown agent: ${job.agent}`);
		}
		const child = spawn(job.agent, args, {
			stdio: "inherit",
			env: {
				...env,
				...(sessionId ? {} : { CHAPPIE_LAUNCH_ID: job.id }),
			},
		});
		// The terminal delivers SIGINT to both the launcher and the agent.
		const interrupt = () => {};
		process.on("SIGINT", interrupt);
		try {
			const [, [code, signal]] = await Promise.all([
				once(child, "spawn").then(async () => {
					if (sessionId) await launched(sessionId);
				}),
				once(child, "exit"),
			]);
			return { code: code as number | null, signal: signal as string | null };
		} finally {
			process.off("SIGINT", interrupt);
		}
	} finally {
		rpc?.close();
	}
}

async function run(
	command: string,
	args: string[],
	options: SpawnOptions = {},
): Promise<string> {
	const child = spawn(command, args, options);
	if (options.detached) child.unref();
	const output: Buffer[] = [];
	const errors: Buffer[] = [];
	child.stdout?.on("data", (data: Buffer) => output.push(data));
	child.stderr?.on("data", (data: Buffer) => errors.push(data));
	child.stdin?.end();
	const [code] = await once(child, "close");
	if (code !== 0)
		throw new Error(
			Buffer.concat(errors).toString().trim() || `${command} exited (${code})`,
		);
	return Buffer.concat(output).toString();
}
