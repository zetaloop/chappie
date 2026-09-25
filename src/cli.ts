#!/usr/bin/env node
import { parseArgs } from "node:util";
import packageJson from "../package.json" with { type: "json" };

const { values } = parseArgs({
	options: {
		help: { type: "boolean", short: "h" },
		version: { type: "boolean", short: "v" },
	},
});

if (values.help) {
	console.log(
		"Usage: chappie\n\nConnect agent sessions to ChatGPT over MCP stdio.",
	);
} else if (values.version) {
	console.log(packageJson.version);
} else {
	try {
		const { serve } = await import("./stdio.ts");
		await serve();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
