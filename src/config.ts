import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";

const configSchema = z.object({
	latestWorkflow: z.boolean().optional(),
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
