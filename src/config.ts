import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";

const configSchema = z.object({
	ask: z.boolean().optional(),
	connect: z.string().min(1).optional(),
	latestWorkflow: z.boolean().optional(),
	listen: z.union([z.boolean(), z.number().int().min(1).max(65535)]).optional(),
});

export async function readConfig(agentDir: string) {
	let contents: string;
	try {
		contents = await readFile(join(agentDir, "chappie.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	return configSchema.parse(JSON.parse(contents));
}
