import {
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

export default async function chappi(pi: ExtensionAPI): Promise<void> {
	pi.registerFlag("chappi", {
		description: "Serve Chappi over MCP",
		type: "boolean",
	});

	if (process.argv.includes("--chappi")) {
		try {
			const { serveChappi } = await import("./stdio.ts");
			await serveChappi();
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	}

	const [{ createChappiProvider }, { LocalSession }, { transfer }] =
		await Promise.all([
			import("./provider.ts"),
			import("./session.ts"),
			import("./transfer.ts"),
		]);
	const session = new LocalSession(pi, getAgentDir());
	session.install();
	pi.registerTool(transfer);
	pi.registerProvider(
		createChappiProvider((output, context) => session.start(output, context)),
	);
}
