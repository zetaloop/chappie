import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	type ExtensionContext,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeResource, registerFile } from "./resources.ts";

interface TransferDetails {
	files: ({ path: string; bytes: number } | { path: string; error: string })[];
	resources: import("./resources.ts").ResourceDescriptor[];
}

export const transferFile = Type.Object({
	file_id: Type.String(),
	download_url: Type.String(),
	file_name: Type.Optional(Type.String()),
	mime_type: Type.Optional(Type.String()),
});

export const transfer = {
	name: "transfer",
	label: "transfer",
	description:
		"Transfer files between ChatGPT and the current Pi session. Provide files to write them to paths; omit files to export existing paths or Chappi image references.",
	parameters: Type.Object({
		paths: Type.Array(Type.String(), { minItems: 1 }),
		files: Type.Optional(Type.Array(transferFile, { minItems: 1 })),
		overwrite: Type.Optional(
			Type.Boolean({ description: "Overwrite existing target files" }),
		),
	}),
	async execute(
		_id: string,
		args: {
			paths: string[];
			files?: { download_url: string }[];
			overwrite?: boolean;
		},
		signal: AbortSignal | undefined,
		_update: unknown,
		context: ExtensionContext,
	): Promise<{
		content: { type: "text"; text: string }[];
		details: TransferDetails;
	}> {
		const sessionId = context.sessionManager.getSessionId();
		if (!args.files) {
			const resources = await Promise.all(
				args.paths.map((requested) =>
					requested.startsWith("chappi://")
						? describeResource(sessionId, requested)
						: registerFile(sessionId, localPath(requested, context.cwd)),
				),
			);
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify({ resources }) },
				],
				details: { files: [], resources },
			};
		}

		if (args.files.length !== args.paths.length) {
			throw new Error(
				"files and paths must contain the same number of entries",
			);
		}
		const files = await Promise.all(
			args.paths.map(async (requested, index) => {
				const path = localPath(requested, context.cwd);
				const source = args.files?.[index];
				if (!source)
					throw new Error("files and paths must correspond by index");
				try {
					const bytes = await importFile(
						path,
						source.download_url,
						args.overwrite === true,
						signal,
					);
					return { path, bytes };
				} catch (error) {
					return {
						path: requested,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		);
		if (files.some((file) => "error" in file)) {
			throw new Error(JSON.stringify({ files }));
		}
		return {
			content: [{ type: "text" as const, text: JSON.stringify({ files }) }],
			details: { files, resources: [] },
		};
	},
};

function localPath(path: string, cwd: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return resolve(homedir(), path.slice(2));
	}
	return resolve(cwd, path);
}

async function importFile(
	path: string,
	url: string,
	overwrite: boolean,
	signal?: AbortSignal,
): Promise<number> {
	return withFileMutationQueue(path, async () => {
		signal?.throwIfAborted();
		await mkdir(dirname(path), { recursive: true });
		const writable = createWriteStream(path, {
			flags: overwrite ? "w" : "wx",
		});
		let opened = false;
		try {
			await once(writable, "open");
			opened = true;
			const response = await fetch(url, signal ? { signal } : {});
			if (!response.ok || !response.body) {
				throw new Error(`Download failed with HTTP ${response.status}`);
			}
			const readable = Readable.from(
				response.body as unknown as AsyncIterable<Uint8Array>,
			);
			if (signal) await pipeline(readable, writable, { signal });
			else await pipeline(readable, writable);
			signal?.throwIfAborted();
			return (await stat(path)).size;
		} catch (error) {
			if (!writable.closed) {
				const closed = once(writable, "close");
				writable.destroy();
				await closed.catch(() => {});
			}
			if (opened) await unlink(path).catch(() => {});
			throw error;
		}
	});
}
