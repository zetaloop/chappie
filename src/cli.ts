#!/usr/bin/env node
import { parseArgs } from "node:util";
import packageJson from "../package.json" with { type: "json" };

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		help: { type: "boolean", short: "h" },
		version: { type: "boolean", short: "v" },
		provider: { type: "boolean" },
	},
});

const usage = "Usage: chappie [codex [setup]]";

if (values.help) {
	console.log(
		`${usage}\n\nRun the broker and ChatGPT MCP server.\nThe codex command runs the installed Codex plugin.\nUse codex setup to write the model catalog to ~/.chappie/codex.json.`,
	);
} else if (values.version) {
	console.log(packageJson.version);
} else {
	try {
		if (
			positionals.length === 2 &&
			positionals[0] === "codex" &&
			positionals[1] === "setup" &&
			!values.provider
		) {
			const { setupCodex } = await import("./codex-plugin.ts");
			console.log(await setupCodex());
		} else if (positionals.length === 1 && positionals[0] === "codex") {
			if (values.provider) {
				const { serveCodex } = await import("./codex.ts");
				await serveCodex();
			} else {
				const { serveCodexPlugin } = await import("./codex-plugin.ts");
				await serveCodexPlugin();
			}
		} else if (positionals.length === 0 && !values.provider) {
			const { serve } = await import("./stdio.ts");
			await serve();
		} else {
			throw new Error(usage);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.send?.({ error: message });
		process.exitCode = 1;
	}
}
