import {
	type ExtensionAPI,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

export default async function chappie(pi: ExtensionAPI): Promise<void> {
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
	const config = await readConfig();
	const session = new LocalSession(pi, agentDir, config.connect);
	session.install();
	pi.registerTool({
		...transfer,
		execute: (...args) => session.transfer(...args),
	});
	pi.registerProvider(createChappieProvider((output) => session.start(output)));
}
