import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
	mkdir,
	mkdtempDisposable,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpClient, requestMeta } from "./mcp.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

await using workspace = await mkdtempDisposable(
	join(tmpdir(), "chappi-package-"),
);
const packDir = join(workspace.path, "pack");
const installDir = join(workspace.path, "install");
const agentDir = join(workspace.path, "agent");
await Promise.all([mkdir(packDir), mkdir(installDir), mkdir(agentDir)]);

await run("pnpm", ["pack", "--pack-destination", packDir], { cwd: root });
const archiveName = (await readdir(packDir)).find((name) =>
	name.endsWith(".tgz"),
);
assert(archiveName);
const archive = join(packDir, archiveName);

await writeFile(join(installDir, "package.json"), '{"private":true}\n');
await run("npm", [
	"install",
	archive,
	"--prefix",
	installDir,
	"--legacy-peer-deps",
]);
const packageDir = join(installDir, "node_modules", "chappi");
const packageJson = JSON.parse(
	await readFile(join(packageDir, "package.json"), "utf8"),
) as { pi?: { extensions?: string[] } };
assert.deepEqual(packageJson.pi?.extensions, ["./src/index.ts"]);

const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
await run("pi", ["install", packageDir], { cwd: root, env });

const child = spawn("pi", ["--chappi"], {
	cwd: root,
	env,
	stdio: "pipe",
});
let errorOutput = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => {
	errorOutput += chunk;
});
const client = new McpClient(child);
const discover = (await client.request("server/discover", {
	_meta: requestMeta,
})) as { supportedVersions?: string[] };
assert.deepEqual(discover.supportedVersions, ["2026-07-28"]);
const tools = (await client.request("tools/list", { _meta: requestMeta })) as {
	tools?: { name?: string }[];
};
assert.deepEqual(
	tools.tools?.map(({ name }) => name),
	[
		"init",
		"chat",
		"tools",
		"call",
		"read",
		"bash",
		"edit",
		"write",
		"transfer",
		"sessions",
	],
);

const exited = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
client.close();
const [code, signal] = (await exited) as [number | null, NodeJS.Signals | null];
assert.equal(signal, null);
assert.equal(code, 0, errorOutput);
