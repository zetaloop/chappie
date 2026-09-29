import { fork } from "node:child_process";
import {
	copyFile,
	mkdir,
	mkdtempDisposable,
	open,
	rename,
} from "node:fs/promises";
import { get } from "node:http";
import { join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import packageJson from "../package.json" with { type: "json" };
import { getDirectory, readConfig } from "./config.ts";
import type { Content } from "./host.ts";
import { definitions } from "./local.ts";
import { type ResourceData, resourceDescriptors } from "./resources.ts";

export async function setupCodex(): Promise<string> {
	await mkdir(getDirectory(), { recursive: true });
	await using temporary = await mkdtempDisposable(
		join(getDirectory(), ".chappie-"),
	);
	const staged = join(temporary.path, "codex.json");
	await copyFile(new URL("./codex.json", import.meta.url), staged);
	const path = join(getDirectory(), "codex.json");
	await rename(staged, path);
	return path;
}

async function startProvider(): Promise<void> {
	await using log = await open(join(getDirectory(), "codex.log"), "a");
	const child = fork(
		new URL("./cli.js", import.meta.url),
		["codex", "--provider"],
		{
			detached: true,
			stdio: ["ignore", "ignore", log.fd, "ipc"],
		},
	);
	try {
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) =>
				reject(
					new Error(`Codex bridge exited (${code}); see ~/.chappie/codex.log`),
				),
			);
			child.once("message", (message: { ready?: boolean; error?: string }) => {
				if (message.ready) resolve();
				else reject(new Error(message.error ?? "Codex bridge did not start"));
			});
		});
	} finally {
		if (child.connected) child.disconnect();
		child.unref();
	}
}

export async function serveCodexPlugin(): Promise<void> {
	await setupCodex();
	const config = await readConfig();
	await startProvider();
	const base = `http://127.0.0.1:${config.codex?.port ?? 24275}`;
	const attached = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	const connection = get(`${base}/client`, (response) => {
		if (response.statusCode !== 200) {
			attached.reject(
				new Error(`Codex bridge returned HTTP ${response.statusCode}`),
			);
			response.destroy();
			return;
		}
		response.resume();
		response.once("close", () => stopped.resolve());
		attached.resolve();
	});
	connection.on("error", (error) => {
		attached.reject(error);
		stopped.resolve();
	});
	await attached.promise;
	const server = new McpServer({
		name: "chappie",
		version: packageJson.version,
	});
	for (const definition of definitions.filter(
		(tool) => config.localTools || tool.name === "transfer",
	)) {
		server.registerTool(
			definition.name,
			{
				description: definition.description,
				inputSchema: definition.parameters,
				...(definition.name === "sessions" ||
				definition.name === "remote_tools" ||
				definition.name === "history"
					? { annotations: { readOnlyHint: true } }
					: {}),
			},
			async (
				args: Record<string, unknown>,
				context: {
					mcpReq: { _meta?: Record<string, unknown>; signal: AbortSignal };
				},
			) => {
				const threadId = context.mcpReq._meta?.threadId;
				if (typeof threadId !== "string")
					throw new Error("Codex did not provide threadId metadata");
				const response = await fetch(`${base}/tools/${definition.name}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ threadId, arguments: args }),
					signal: context.mcpReq.signal,
				});
				const result = (await response.json()) as {
					content: Content[];
					details?: unknown;
					error?: { message: string };
				};
				if (!response.ok)
					throw new Error(
						result.error?.message ?? `Chappie returned HTTP ${response.status}`,
					);
				return {
					content: [
						...result.content,
						...resourceDescriptors(result.details).map((resource) => {
							const uri = new URL(resource.uri);
							uri.searchParams.set("threadId", threadId);
							return {
								type: "resource_link" as const,
								...resource,
								uri: uri.href,
							};
						}),
					],
					...(result.details && typeof result.details === "object"
						? { _meta: { details: result.details } }
						: {}),
				};
			},
		);
	}
	server.registerResource(
		"Session resource",
		new ResourceTemplate(
			"chappie://session/{sessionId}/{kind}/{id}/{name}{?threadId}",
			{ list: undefined },
		),
		{},
		async (uri, _variables, context) => {
			const threadId = uri.searchParams.get("threadId");
			if (!threadId) throw new Error("Resource URI requires threadId");
			const requested = uri.href;
			uri.search = "";
			const response = await fetch(`${base}/resource`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ threadId, uri: uri.href }),
				signal: context.mcpReq.signal,
			});
			const resource = (await response.json()) as ResourceData & {
				error?: { message: string };
			};
			if (!response.ok)
				throw new Error(
					resource.error?.message ?? `Chappie returned HTTP ${response.status}`,
				);
			return {
				contents: [
					{ uri: requested, mimeType: resource.mimeType, blob: resource.blob },
				],
			};
		},
	);
	const handle = serveStdio(() => server);
	process.stdin.once("end", () => stopped.resolve());
	process.stdin.once("close", () => stopped.resolve());
	try {
		await stopped.promise;
	} finally {
		connection.destroy();
		await handle.close();
	}
}
