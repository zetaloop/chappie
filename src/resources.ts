import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import mime from "mime";

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

const stores = new Map<string, Map<string, ResourceEntry>>();

export async function registerFile(
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
	store(sessionId).set(descriptor.uri, { type: "file", path, descriptor });
	return descriptor;
}

export function rememberImages(
	sessionId: string,
	content: readonly (TextContent | ImageContent)[],
): void {
	for (const block of content) {
		if (block.type !== "image") continue;
		const descriptor = imageDescriptor(sessionId, block);
		store(sessionId).set(descriptor.uri, {
			type: "image",
			data: block.data,
			descriptor,
		});
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
							piImage: imageDescriptor(sessionId, block).uri,
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

export function describeResource(
	sessionId: string,
	uri: string,
): ResourceDescriptor {
	const parsed = parseResourceUri(uri);
	if (parsed.sessionId !== sessionId) {
		throw new Error("The resource belongs to another Pi session");
	}
	const entry = store(sessionId).get(uri);
	if (!entry) throw new Error(`Unknown Chappi resource: ${uri}`);
	return entry.descriptor;
}

export async function readSessionResource(
	sessionId: string,
	uri: string,
): Promise<ResourceData> {
	const descriptor = describeResource(sessionId, uri);
	const entry = store(sessionId).get(uri);
	if (!entry) throw new Error(`Unknown Chappi resource: ${uri}`);
	const blob =
		entry.type === "file"
			? (await readFile(entry.path)).toString("base64")
			: entry.data;
	return { ...descriptor, blob };
}

export function resourceSessionId(uri: string): string {
	return parseResourceUri(uri).sessionId;
}

function store(sessionId: string): Map<string, ResourceEntry> {
	let resources = stores.get(sessionId);
	if (!resources) {
		resources = new Map();
		stores.set(sessionId, resources);
	}
	return resources;
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
		uri: `chappi://session/${encodeURIComponent(sessionId)}/${kind}/${encodeURIComponent(id)}/${encodeURIComponent(name)}`,
		name,
		mimeType,
		size,
	};
}

function parseResourceUri(uri: string): {
	sessionId: string;
	kind: string;
	id: string;
	name: string;
} {
	const parsed = new URL(uri);
	if (parsed.protocol !== "chappi:" || parsed.hostname !== "session") {
		throw new Error(`Unsupported Chappi resource: ${uri}`);
	}
	const parts = parsed.pathname
		.slice(1)
		.split("/")
		.map((part) => decodeURIComponent(part));
	if (parts.length !== 4 || !parts.every(Boolean)) {
		throw new Error(`Invalid Chappi resource: ${uri}`);
	}
	const [sessionId, kind, id, name] = parts;
	if (!sessionId || !kind || !id || !name) {
		throw new Error(`Invalid Chappi resource: ${uri}`);
	}
	return { sessionId, kind, id, name };
}
