import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import mime from "mime";
import type { Content, ImageContent, TextContent } from "./host.ts";

export interface ResourceDescriptor {
	uri: string;
	name: string;
	mimeType: string;
	size: number;
}

export interface ResourceData extends ResourceDescriptor {
	blob: string;
}

type ResourceEntry =
	| { type: "file"; path: string; descriptor: ResourceDescriptor }
	| { type: "image"; data: string; descriptor: ResourceDescriptor };

export class Resources {
	readonly #entries = new Map<string, ResourceEntry>();

	list(): ResourceDescriptor[] {
		return [...this.#entries.values()].map((entry) => entry.descriptor);
	}

	async registerFile(
		sessionId: string,
		path: string,
	): Promise<ResourceDescriptor> {
		const info = await stat(path);
		if (!info.isFile()) throw new Error(`${path} is not a file`);
		const name = basename(path);
		const descriptor = resourceDescriptor(
			sessionId,
			"file",
			randomUUID(),
			name,
			mime.getType(path) ?? "application/octet-stream",
			info.size,
		);
		this.#entries.set(descriptor.uri, { type: "file", path, descriptor });
		return descriptor;
	}

	rememberImages(
		sessionId: string,
		content: readonly (Content | { type: "resource_link" })[],
	): ResourceDescriptor[] {
		return content.flatMap((block) => {
			if (block.type !== "image") return [];
			const descriptor = imageDescriptor(sessionId, block);
			this.#entries.set(descriptor.uri, {
				type: "image",
				data: block.data,
				descriptor,
			});
			return [descriptor];
		});
	}

	describe(sessionId: string, uri: string): ResourceDescriptor {
		return this.#entry(sessionId, uri).descriptor;
	}

	async read(
		sessionId: string,
		uri: string,
		offset?: number,
	): Promise<ResourceData> {
		const entry = this.#entry(sessionId, uri);
		const { descriptor } = entry;
		if (offset === undefined) {
			const blob =
				entry.type === "file"
					? (await readFile(entry.path)).toString("base64")
					: entry.data;
			return { ...descriptor, blob };
		}
		if (!Number.isSafeInteger(offset) || offset < 0)
			throw new Error("Resource offset must be a nonnegative integer");
		const length = Math.min(1024 * 1024, Math.max(0, descriptor.size - offset));
		let data: Buffer;
		if (entry.type === "file") {
			await using file = await open(entry.path, "r");
			const { buffer, bytesRead } = await file.read(
				Buffer.alloc(length),
				0,
				length,
				offset,
			);
			data = buffer.subarray(0, bytesRead);
		} else {
			data = Buffer.from(entry.data, "base64").subarray(
				offset,
				offset + length,
			);
		}
		return { ...descriptor, blob: data.toString("base64") };
	}

	#entry(sessionId: string, uri: string): ResourceEntry {
		if (resourceSessionId(uri) !== sessionId)
			throw new Error("The resource belongs to another session");
		const entry = this.#entries.get(uri);
		if (!entry) throw new Error(`Unknown Chappie resource: ${uri}`);
		return entry;
	}
}

export function imageDescriptor(
	sessionId: string,
	image: ImageContent,
): ResourceDescriptor {
	const digest = createHash("sha256")
		.update(image.data, "base64")
		.digest("hex");
	const extension = mime.getExtension(image.mimeType) ?? "bin";
	return resourceDescriptor(
		sessionId,
		"image",
		digest,
		`image.${extension}`,
		image.mimeType,
		Buffer.byteLength(image.data, "base64"),
	);
}

export function contentWithImageReferences(
	sessionId: string,
	content: readonly (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	return content.flatMap((block) =>
		block.type === "image"
			? [
					block,
					{
						type: "text" as const,
						text: JSON.stringify({
							image: imageDescriptor(sessionId, block).uri,
						}),
					},
				]
			: [block],
	);
}

export function resourceDescriptors(details: unknown): ResourceDescriptor[] {
	if (!details || typeof details !== "object") return [];
	const resources = (details as { resources?: unknown }).resources;
	if (!Array.isArray(resources)) return [];
	return resources.filter((resource): resource is ResourceDescriptor => {
		if (!resource || typeof resource !== "object") return false;
		const value = resource as Partial<ResourceDescriptor>;
		return (
			typeof value.uri === "string" &&
			typeof value.name === "string" &&
			typeof value.mimeType === "string" &&
			typeof value.size === "number"
		);
	});
}

export function resourceSessionId(uri: string): string {
	const parsed = new URL(uri);
	if (parsed.protocol !== "chappie:" || parsed.hostname !== "session") {
		throw new Error(`Unsupported Chappie resource: ${uri}`);
	}
	const [sessionId, kind, id, name, ...rest] = parsed.pathname
		.slice(1)
		.split("/")
		.map((part) => decodeURIComponent(part));
	if (!sessionId || !kind || !id || !name || rest.length) {
		throw new Error(`Invalid Chappie resource: ${uri}`);
	}
	return sessionId;
}

function resourceDescriptor(
	sessionId: string,
	kind: "file" | "image",
	id: string,
	name: string,
	mimeType: string,
	size: number,
): ResourceDescriptor {
	return {
		uri: `chappie://session/${encodeURIComponent(sessionId)}/${kind}/${encodeURIComponent(id)}/${encodeURIComponent(name)}`,
		name,
		mimeType,
		size,
	};
}
