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

	const agentDir = getAgentDir();
	const [
		{ readConfig },
		{ createChappieProvider },
		{ LocalSession },
		{ transfer },
	] = await Promise.all([
		import("./config.ts"),
		import("./provider.ts"),
		import("./session.ts"),
		import("./transfer.ts"),
	]);
	const config = await readConfig(agentDir);
	const session = new LocalSession(pi, agentDir, config.connect);
	session.install();
	pi.registerTool({
		...transfer,
		execute: (...args) => session.transfer(...args),
	});
	pi.registerProvider(createChappieProvider((output) => session.start(output)));
}
