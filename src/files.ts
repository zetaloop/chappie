import { createWriteStream } from "node:fs";
import { link, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as z from "zod";
import {
	describeResource,
	type ResourceDescriptor,
	registerFile,
} from "./resources.ts";

export interface TransferDetails {
	device: string;
	files: ({ path: string; bytes: number } | { path: string; error: string })[];
	resources: ResourceDescriptor[];
	to?: { sessionId: string; device: string };
	from?: { sessionId: string; device: string };
}

export type FileMutation = <T>(
	path: string,
	write: () => Promise<T>,
) => Promise<T>;

export interface FileContext {
	id: string;
	cwd: string;
	mutate?: FileMutation;
}

export interface TransferResult {
	content: { type: "text"; text: string }[];
	details: TransferDetails;
}

export const transferFile = z.object({
	file_id: z.string().describe("Host file identifier"),
	download_url: z.string().describe("Host-provided download URL"),
	file_name: z.string().optional(),
	mime_type: z.string().optional(),
});

export const transferInput = z.object({
	paths: z
		.array(z.string())
		.min(1)
		.describe(
			"Destination paths for import; source paths or chappie:// image references for export or session copies",
		),
	files: z
		.array(transferFile)
		.min(1)
		.optional()
		.describe(
			"ChatGPT files paired with paths in order; omit for session sources",
		),
	from: z
		.object({
			sessionId: z.string().describe("Source session"),
			paths: z
				.array(z.string())
				.min(1)
				.describe("Source paths paired with local destinations"),
		})
		.optional(),
	to: z
		.object({
			sessionId: z.string().describe("Destination session"),
			paths: z
				.array(z.string())
				.min(1)
				.describe("Destinations paired with source paths in order"),
		})
		.optional(),
	overwrite: z.boolean().optional().describe("Overwrite existing target files"),
});

export type TransferInput = z.infer<typeof transferInput>;

export const transferDescription =
	"Import ChatGPT files with files, send local paths to a session with to, or retrieve session files with from. Otherwise, export local paths or chappie:// image references as resources.";

export async function transferFiles(
	args: TransferInput,
	context: FileContext,
	signal?: AbortSignal,
	update?: (details: TransferDetails) => void,
): Promise<TransferResult> {
	const device = hostname();
	update?.({ device, files: [], resources: [] });
	if (!args.files) {
		const resources = await Promise.all(
			args.paths.map((requested) =>
				requested.startsWith("chappie://")
					? describeResource(context.id, requested)
					: registerFile(context.id, localPath(requested, context.cwd)),
			),
		);
		return transferResult({ device, files: [], resources });
	}
	if (args.files.length !== args.paths.length) {
		throw new Error("files and paths must contain the same number of entries");
	}
	const files = await Promise.all(
		args.paths.map(async (requested, index) => {
			const path = localPath(requested, context.cwd);
			const source = args.files?.[index];
			if (!source) throw new Error("files and paths must correspond by index");
			try {
				const read = async function* () {
					const response = await fetch(
						source.download_url,
						signal ? { signal } : {},
					);
					if (!response.ok || !response.body) {
						throw new Error(`Download failed with HTTP ${response.status}`);
					}
					yield* response.body;
				};
				const bytes = await importFile(
					path,
					read(),
					args.overwrite === true,
					signal,
					context.mutate,
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
	return transferResult({ device, files, resources: [] });
}

export function transferResult(details: TransferDetails): TransferResult {
	if (details.files.some((file) => "error" in file)) {
		throw new Error(
			details.files
				.map((file) =>
					"error" in file
						? `${file.path}: ${file.error}`
						: `${file.path}  ${file.bytes} bytes`,
				)
				.join("\n"),
		);
	}
	return {
		content: [{ type: "text", text: JSON.stringify(details) }],
		details,
	};
}

export async function copyFiles(
	paths: string[],
	resources: ResourceDescriptor[],
	cwd: string,
	overwrite: boolean,
	read: (resource: ResourceDescriptor) => AsyncIterable<Uint8Array>,
	signal: AbortSignal,
	mutate?: FileMutation,
): Promise<TransferDetails["files"]> {
	if (paths.length !== resources.length)
		throw new Error("Source and destination counts must match");
	return Promise.all(
		paths.map(async (requested, index) => {
			const path = localPath(requested, cwd);
			try {
				const resource = resources[index];
				if (!resource) throw new Error("Missing source resource");
				const bytes = await importFile(
					path,
					read(resource),
					overwrite,
					signal,
					mutate,
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
}

export function localPath(path: string, cwd: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\"))
		return resolve(homedir(), path.slice(2));
	return resolve(cwd, path);
}

async function importFile(
	path: string,
	content: AsyncIterable<Uint8Array>,
	overwrite: boolean,
	signal?: AbortSignal,
	mutate?: FileMutation,
): Promise<number> {
	const write = async () => {
		signal?.throwIfAborted();
		await mkdir(dirname(path), { recursive: true });
		const temporary = await mkdtemp(join(dirname(path), ".chappie-"));
		try {
			const staged = join(temporary, "file");
			const readable = Readable.from(content, { objectMode: false });
			const writable = createWriteStream(staged, { flags: "wx" });
			if (signal) await pipeline(readable, writable, { signal });
			else await pipeline(readable, writable);
			signal?.throwIfAborted();
			const bytes = (await stat(staged)).size;
			if (overwrite) await rename(staged, path);
			else await link(staged, path);
			return bytes;
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	};
	return mutate ? mutate(path, write) : write();
}
