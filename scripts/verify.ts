import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, requestMeta } from "./mcp.ts";

function record(value: unknown): Record<string, unknown> {
	assert(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}

interface RunningBroker {
	child: ChildProcessWithoutNullStreams;
	client: McpClient;
	stderr(): string;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));

async function startBroker(agentDir: string): Promise<RunningBroker> {
	const child = spawn(
		"pi",
		["--no-extensions", "--extension", extension, "--chappi"],
		{
			cwd: root,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: "pipe",
		},
	);
	let errorOutput = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		errorOutput += chunk;
	});
	const client = new McpClient(child);
	const discover = record(
		await client.request("server/discover", { _meta: requestMeta }),
	);
	assert.deepEqual(discover.supportedVersions, ["2026-07-28"]);
	return { child, client, stderr: () => errorOutput };
}

async function stopBroker(broker: RunningBroker): Promise<void> {
	const exited = once(broker.child, "exit", {
		signal: AbortSignal.timeout(10_000),
	});
	broker.client.close();
	const [code, signal] = (await exited) as [
		number | null,
		NodeJS.Signals | null,
	];
	assert.equal(signal, null);
	assert.equal(code, 0, broker.stderr());
}

async function listSessions(
	client: McpClient,
): Promise<Array<Record<string, unknown>>> {
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
	const body = record(JSON.parse(String(content.text)));
	assert(Array.isArray(body.sessions));
	return body.sessions.map(record);
}

await using workspace = await mkdtempDisposable(join(tmpdir(), "chappi-"));
const agentDir = join(workspace.path, "agent");
const firstCwd = join(workspace.path, "first");
const secondCwd = join(workspace.path, "second");
await Promise.all([mkdir(agentDir), mkdir(firstCwd), mkdir(secondCwd)]);
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const { default: chappi } = await import("../src/index.ts");

async function createNativeSession(cwd: string) {
	const settings = SettingsManager.inMemory({ retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		extensionFactories: [chappi],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager: settings,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
	});
	await session.bindExtensions({
		onError(error) {
			throw new Error(`${error.event}: ${error.error}`);
		},
	});
	const model = session.modelRuntime.getModel("chappi", "chatgpt");
	assert(model);
	await session.setModel(model);
	return session;
}

type NativeSession = Awaited<ReturnType<typeof createNativeSession>>;

async function startProvider(
	session: NativeSession,
	text: string,
): Promise<{ run: Promise<void> }> {
	const started = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "assistant") {
			unsubscribe();
			started.resolve();
		}
	});
	const run = session.prompt(text);
	await started.promise;
	return { run };
}

let broker = await startBroker(agentDir);
const listed = record(
	await broker.client.request("tools/list", { _meta: requestMeta }),
);
assert(Array.isArray(listed.tools));
assert.deepEqual(
	listed.tools.map((tool) => record(tool).name),
	["sessions"],
);
assert.deepEqual(await listSessions(broker.client), []);

const first = await createNativeSession(firstCwd);
const second = await createNativeSession(secondCwd);
let { run: firstRun } = await startProvider(
	first,
	"Connect the first session.",
);
let { run: secondRun } = await startProvider(
	second,
	"Connect the second session.",
);
assert.deepEqual(
	(await listSessions(broker.client)).map(({ id, cwd, status }) => ({
		id,
		cwd,
		status,
	})),
	[
		{ id: first.sessionManager.getSessionId(), cwd: firstCwd, status: "ready" },
		{
			id: second.sessionManager.getSessionId(),
			cwd: secondCwd,
			status: "ready",
		},
	],
);

await stopBroker(broker);
await Promise.all([firstRun, secondRun]);
broker = await startBroker(agentDir);
firstRun = (await startProvider(first, "Reconnect the first session.")).run;
secondRun = (await startProvider(second, "Reconnect the second session.")).run;
assert.deepEqual(
	(await listSessions(broker.client)).map(({ id, cwd, status }) => ({
		id,
		cwd,
		status,
	})),
	[
		{ id: first.sessionManager.getSessionId(), cwd: firstCwd, status: "ready" },
		{
			id: second.sessionManager.getSessionId(),
			cwd: secondCwd,
			status: "ready",
		},
	],
);

const duplicate = spawn(
	"pi",
	["--no-extensions", "--extension", extension, "--chappi"],
	{
		cwd: root,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		stdio: "pipe",
	},
);
const [duplicateCode] = (await once(duplicate, "exit", {
	signal: AbortSignal.timeout(10_000),
})) as [number | null, NodeJS.Signals | null];
assert.notEqual(duplicateCode, 0);

await Promise.all([first.abort(), second.abort()]);
await Promise.all([firstRun, secondRun]);
await stopBroker(broker);
first.dispose();
second.dispose();
