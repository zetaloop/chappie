import { once } from "node:events";
import { createWriteStream } from "node:fs";
import {
	link,
	mkdir,
	mkdtempDisposable,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	type ExtensionContext,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	describeResource,
	type ResourceDescriptor,
	registerFile,
} from "./resources.ts";

export interface TransferDetails {
	files: ({ path: string; bytes: number } | { path: string; error: string })[];
	resources: ResourceDescriptor[];
	to?: { sessionId: string; device: string };
}

export const transferFile = Type.Object({
	file_id: Type.String({ description: "Host file identifier" }),
	download_url: Type.String({ description: "Host-provided download URL" }),
	file_name: Type.Optional(Type.String()),
	mime_type: Type.Optional(Type.String()),
});

export const transfer = {
	name: "transfer",
	label: "transfer",
	description:
		"Copy ChatGPT files into Pi paths with files, or copy Pi files to another session with to. Otherwise, return resource links for Pi paths or Chappie image references.",
	parameters: Type.Object({
		paths: Type.Array(Type.String(), {
			minItems: 1,
			description:
				"Pi destinations for import; Pi source paths or chappie:// image references for export or session copies",
		}),
		files: Type.Optional(
			Type.Array(transferFile, {
				minItems: 1,
				description:
					"ChatGPT files paired with paths in order; omit for Pi sources",
			}),
		),
		to: Type.Optional(
			Type.Object({
				sessionId: Type.String({ description: "Destination Pi session" }),
				paths: Type.Array(Type.String(), {
					minItems: 1,
					description: "Destinations paired with source paths in order",
				}),
			}),
		),
		overwrite: Type.Optional(
			Type.Boolean({ description: "Overwrite existing target files" }),
		),
	}),
	async execute(
		_id: string,
		args: {
			paths: string[];
			files?: { download_url: string }[];
			to?: { sessionId: string; paths: string[] };
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
					requested.startsWith("chappie://")
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

export async function copyFiles(
	paths: string[],
	resources: ResourceDescriptor[],
	cwd: string,
	overwrite: boolean,
	read: (resource: ResourceDescriptor) => AsyncIterable<Uint8Array>,
	signal: AbortSignal,
): Promise<TransferDetails["files"]> {
	if (paths.length !== resources.length)
		throw new Error("Source and destination counts must match");
	return Promise.all(
		paths.map(async (requested, index) => {
			const path = localPath(requested, cwd);
			try {
				const resource = resources[index];
				if (!resource) throw new Error("Missing source resource");
				const bytes = await withFileMutationQueue(path, async () => {
					signal.throwIfAborted();
					await mkdir(dirname(path), { recursive: true });
					await using temporary = await mkdtempDisposable(
						join(dirname(path), ".chappie-"),
					);
					const staged = join(temporary.path, "file");
					const bytes = await importFile(staged, read(resource), false, signal);
					signal.throwIfAborted();
					if (overwrite) await rename(staged, path);
					else await link(staged, path);
					return bytes;
				});
				return { path, bytes };
			} catch (error) {
				return {
					path: requested,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}),
	);
}

function localPath(path: string, cwd: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return resolve(homedir(), path.slice(2));
	}
	return resolve(cwd, path);
}

async function importFile(
	path: string,
	source: string | AsyncIterable<Uint8Array>,
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
			let content: AsyncIterable<Uint8Array>;
			if (typeof source === "string") {
				const response = await fetch(source, signal ? { signal } : {});
				if (!response.ok || !response.body) {
					throw new Error(`Download failed with HTTP ${response.status}`);
				}
				content = response.body as unknown as AsyncIterable<Uint8Array>;
			} else content = source;
			const readable = Readable.from(content, { objectMode: false });
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
