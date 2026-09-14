import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import packageJson from "../package.json" with { type: "json" };
import type { Broker } from "./broker.ts";

const instructions = readFileSync(
	new URL("./instructions.md", import.meta.url),
	"utf8",
).trim();

export function createServer(broker: Broker): McpServer {
	const server = new McpServer(
		{
			name: "chappi",
			version: packageJson.version,
		},
		{ instructions },
	);

	server.registerTool(
		"sessions",
		{
			title: "Local sessions",
			description: "List the Pi sessions connected to Chappi.",
			inputSchema: z.object({}),
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({ sessions: broker.listSessions() }),
				},
			],
		}),
	);

	return server;
}
