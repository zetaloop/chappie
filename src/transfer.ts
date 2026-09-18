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
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	formatSize,
	type ToolDefinition,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
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
}

export const transferFile = Type.Object({
	file_id: Type.String({ description: "Host file identifier" }),
	download_url: Type.String({ description: "Host-provided download URL" }),
	file_name: Type.Optional(Type.String()),
	mime_type: Type.Optional(Type.String()),
});

const parameters = Type.Object({
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
});

export const transfer = {
	name: "transfer",
	label: "transfer",
	description:
		"Copy ChatGPT files into Pi paths with files, or copy Pi files to another session with to. Otherwise, return resource links for Pi paths or Chappie image references.",
	parameters,
	async execute(
		_id,
		args,
		signal,
		update,
		context,
	): Promise<{
		content: { type: "text"; text: string }[];
		details: TransferDetails;
	}> {
		const sessionId = context.sessionManager.getSessionId();
		const device = hostname();
		update?.({ content: [], details: { device, files: [], resources: [] } });
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
				details: { device, files: [], resources },
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
		return transferResult({ device, files, resources: [] });
	},
	renderCall(args, theme, context) {
		const device = context.state.device ?? hostname();
		const from = args.files ? "ChatGPT" : device;
		const to = args.files
			? device
			: (context.state.to ?? (args.to ? "Pi" : "ChatGPT"));
		const header =
			context.lastComponent instanceof Text
				? context.lastComponent
				: new Text("", 0, 0);
		header.setText(theme.fg("toolTitle", theme.bold(`${from} → ${to}`)));
		context.state.header = header;
		return header;
	},
	renderResult(result, _options, theme, context) {
		const details = result.details;
		if (!details) {
			const text = result.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("\n");
			return new Text(
				theme.fg(context.isError ? "error" : "toolOutput", text),
				0,
				0,
			);
		}
		const args = context.args;
		context.state.device = details.device;
		context.state.to = details.to?.device ?? "ChatGPT";
		const from = args.files ? "ChatGPT" : details.device;
		const to = args.files ? details.device : (details.to?.device ?? "ChatGPT");
		context.state.header?.setText(
			theme.fg("toolTitle", theme.bold(`${from} → ${to}`)),
		);
		const lines =
			details.resources.length > 0
				? details.resources.map((resource, index) => {
						const source = displayPath(args.paths?.[index] ?? resource.name);
						const destination = args.to?.paths[index];
						return `${destination ? `${source} → ${destination}` : source}  ${theme.fg("dim", formatSize(resource.size))}`;
					})
				: details.files.length > 0
					? details.files.map((file, index) => {
							const source = args.to
								? args.paths?.[index]
								: args.files?.[index]?.file_name;
							const path = source
								? `${displayPath(source)} → ${file.path}`
								: file.path;
							return "error" in file
								? theme.fg("error", `${path}\n${file.error}`)
								: `${path}  ${theme.fg("dim", formatSize(file.bytes))}`;
						})
					: (args.paths ?? []).map((path, index) =>
							args.to?.paths[index]
								? `${displayPath(path)} → ${args.to.paths[index]}`
								: displayPath(path),
						);
		return new Text(lines.join("\n"), 0, 0);
	},
} satisfies ToolDefinition<
	typeof parameters,
	TransferDetails,
	{ header?: Text; device?: string; to?: string }
>;

function displayPath(path: string): string {
	return path.startsWith("chappie://")
		? decodeURIComponent(basename(new URL(path).pathname))
		: path;
}

export function transferResult(details: TransferDetails): {
	content: { type: "text"; text: string }[];
	details: TransferDetails;
} {
	if (details.files.some((file) => "error" in file)) {
		throw new Error(
			details.files
				.map((file) =>
					"error" in file
						? `${file.path}: ${file.error}`
						: `${file.path}  ${formatSize(file.bytes)}`,
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
