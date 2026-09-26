#!/usr/bin/env node
import { parseArgs } from "node:util";
import packageJson from "../package.json" with { type: "json" };

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		help: { type: "boolean", short: "h" },
		version: { type: "boolean", short: "v" },
		provider: { type: "boolean" },
		chatgpt: { type: "boolean" },
	},
});

if (values.help) {
	console.log(
		"Usage: chappie [codex]\n\nConnect agent sessions to ChatGPT over MCP stdio.\nThe codex command runs the installed Codex plugin.",
	);
} else if (values.version) {
	console.log(packageJson.version);
} else {
	try {
		if (positionals.length === 1 && positionals[0] === "codex") {
			if (values.provider) {
				const { serveCodex } = await import("./codex.ts");
				await serveCodex();
			} else {
				const { serveCodexPlugin } = await import("./codex-plugin.ts");
				await serveCodexPlugin(values.chatgpt);
			}
		} else if (
			positionals.length === 0 &&
			!values.provider &&
			!values.chatgpt
		) {
			const { serve } = await import("./stdio.ts");
			await serve();
		} else {
			throw new Error("Usage: chappie [codex]");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.send?.({ error: message });
		process.exitCode = 1;
	}
}
