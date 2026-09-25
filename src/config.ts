import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod";

const configSchema = z.object({
	ask: z.boolean().optional(),
	connect: z.string().min(1).optional(),
	listen: z.union([z.boolean(), z.number().int().min(1).max(65535)]).optional(),
});

export function getDirectory(): string {
	return join(homedir(), ".chappie");
}

export async function readConfig(directory = getDirectory()) {
	let contents: string;
	try {
		contents = await readFile(join(directory, "config.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	return configSchema.parse(JSON.parse(contents));
}
