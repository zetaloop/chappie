import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default async function chappi(pi: ExtensionAPI): Promise<void> {
	pi.registerFlag("chappi", {
		description: "Serve Chappi over MCP",
		type: "boolean",
	});

	if (process.argv.includes("--chappi")) {
		const { serveChappi } = await import("./stdio.ts");
		await serveChappi();
	}
}
