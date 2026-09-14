import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { McpClient, requestMeta } from "./mcp.ts";

function record(value: unknown): Record<string, unknown> {
	assert(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const child = spawn(
	"pi",
	["--no-extensions", "--extension", extension, "--chappi"],
	{
		cwd: root,
		stdio: "pipe",
	},
);
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => {
	stderr += chunk;
});

const client = new McpClient(child);
try {
	const discover = record(
		await client.request("server/discover", { _meta: requestMeta }),
	);
	assert.deepEqual(discover.supportedVersions, ["2026-07-28"]);

	const listed = record(
		await client.request("tools/list", { _meta: requestMeta }),
	);
	assert(Array.isArray(listed.tools));
	assert.deepEqual(
		listed.tools.map((tool) => record(tool).name),
		["sessions"],
	);

	const called = record(
		await client.request("tools/call", {
			_meta: requestMeta,
			name: "sessions",
			arguments: {},
		}),
	);
	assert(Array.isArray(called.content));
	const content = record(called.content[0]);
	assert.equal(content.type, "text");
	assert.deepEqual(JSON.parse(String(content.text)), { sessions: [] });

	const exited = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
	client.close();
	const [code, signal] = (await exited) as [
		number | null,
		NodeJS.Signals | null,
	];
	assert.equal(signal, null);
	assert.equal(code, 0, stderr);
} finally {
	if (child.exitCode === null && child.signalCode === null)
		child.kill("SIGTERM");
}
