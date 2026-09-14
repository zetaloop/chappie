import {
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

export default async function chappie(pi: ExtensionAPI): Promise<void> {
	pi.registerFlag("chappie", {
		description: "Serve Chappie over MCP",
		type: "boolean",
	});

	if (process.argv.includes("--chappie")) {
		try {
			const { serveChappie } = await import("./stdio.ts");
			await serveChappie();
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	}

	const [{ createChappieProvider }, { LocalSession }, { transfer }] =
		await Promise.all([
			import("./provider.ts"),
			import("./session.ts"),
			import("./transfer.ts"),
		]);
	const session = new LocalSession(pi, getAgentDir());
	session.install();
	pi.registerTool(transfer);
	pi.registerProvider(
		createChappieProvider((output, context) => session.start(output, context)),
	);
}
