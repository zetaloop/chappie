import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

async function callToolResult(
	client: McpClient,
	chatId: string,
	name: string,
	arguments_: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const called = record(
		await client.request("tools/call", {
			_meta: { ...requestMeta, "openai/session": chatId },
			name,
			arguments: arguments_,
		}),
	);
	assert.notEqual(called.isError, true, JSON.stringify(called));
	return called;
}

async function callTool(
	client: McpClient,
	chatId: string,
	name: string,
	arguments_: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const called = await callToolResult(client, chatId, name, arguments_);
	assert(Array.isArray(called.content));
	const content = record(called.content[0]);
	assert.equal(content.type, "text");
	return record(JSON.parse(String(content.text)));
}

await using workspace = await mkdtempDisposable(join(tmpdir(), "chappi-"));
const agentDir = join(workspace.path, "agent");
const firstCwd = join(workspace.path, "first");
const secondCwd = join(workspace.path, "second");
await Promise.all([mkdir(agentDir), mkdir(firstCwd), mkdir(secondCwd)]);
await writeFile(
	join(agentDir, "AGENTS.md"),
	"Use the Chappi verification workspace.\n",
);
await Promise.all([
	writeFile(join(firstCwd, "first.txt"), "first session\n"),
	writeFile(join(secondCwd, "second.txt"), "second session\n"),
]);
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const { default: chappi } = await import("../src/index.ts");

const holdStarted = Promise.withResolvers<void>();
const holdRelease = Promise.withResolvers<void>();
const verificationTools: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "echo",
		label: "Echo",
		description: "Return the supplied value.",
		parameters: Type.Object({ value: Type.String() }),
		async execute(_id, { value }) {
			return { content: [{ type: "text", text: value }], details: {} };
		},
	});
	pi.registerTool({
		name: "hold",
		label: "Hold",
		description: "Wait until the verification releases this tool.",
		parameters: Type.Object({}),
		async execute() {
			holdStarted.resolve();
			await holdRelease.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	});
};

async function createNativeSession(cwd: string) {
	const settings = SettingsManager.inMemory({ retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		extensionFactories: [chappi, verificationTools],
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

function assistantTexts(session: NativeSession): string[] {
	return session.state.messages.flatMap((message) =>
		message.role === "assistant"
			? message.content.flatMap((content) =>
					content.type === "text" ? [content.text] : [],
				)
			: [],
	);
}

function resultTexts(result: Record<string, unknown>): string[] {
	assert(Array.isArray(result.content));
	return result.content.flatMap((content) => {
		const block = record(content);
		return block.type === "text" ? [String(block.text)] : [];
	});
}

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
	[
		"init",
		"chat",
		"tools",
		"call",
		"read",
		"bash",
		"edit",
		"write",
		"sessions",
	],
);
assert.deepEqual(await callTool(broker.client, "chat-a", "sessions"), {
	binding: null,
	sessions: [],
});

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

const firstId = first.sessionManager.getSessionId();
const secondId = second.sessionManager.getSessionId();
const firstInit = await callTool(broker.client, "chat-a", "init");
assert.equal(record(firstInit.session).id, firstId);
assert.match(JSON.stringify(firstInit.input), /Connect the first session/);
assert.equal(
	firstInit.globalAgents,
	"Use the Chappi verification workspace.\n",
);
const secondInit = await callTool(broker.client, "chat-b", "init");
assert.equal(record(secondInit.session).id, secondId);
assert.match(JSON.stringify(secondInit.input), /Connect the second session/);

const catalog = await callTool(broker.client, "chat-a", "tools");
assert.deepEqual(
	(catalog.tools as unknown[]).map((tool) => record(tool).name),
	["read", "bash", "edit", "write", "echo", "hold"],
);
const directRead = await callToolResult(broker.client, "chat-a", "read", {
	path: "first.txt",
});
assert.match(resultTexts(directRead).join("\n"), /first session/);
const batch = await callToolResult(broker.client, "chat-a", "call", {
	calls: [
		{ name: "echo", arguments: { value: "batch echo" } },
		{ name: "read", arguments: { path: "first.txt" } },
	],
});
assert.match(resultTexts(batch).join("\n"), /batch echo/);
assert.match(resultTexts(batch).join("\n"), /first session/);

const held = callToolResult(broker.client, "chat-a", "call", {
	calls: [{ name: "hold", arguments: {} }],
});
await holdStarted.promise;
const independentRead = await callToolResult(broker.client, "chat-b", "read", {
	path: "second.txt",
});
assert.match(resultTexts(independentRead).join("\n"), /second session/);
holdRelease.resolve();
assert.match(resultTexts(await held).join("\n"), /released/);

await callTool(broker.client, "chat-a", "chat", {
	text: "First remote assistant reply.",
});
await firstRun;
assert.deepEqual(assistantTexts(first).slice(-1), [
	"First remote assistant reply.",
]);
await callTool(broker.client, "chat-a", "chat", {
	text: "Second remote assistant reply.",
});
assert.deepEqual(assistantTexts(first).slice(-2), [
	"First remote assistant reply.",
	"Second remote assistant reply.",
]);
await callTool(broker.client, "chat-b", "chat", {
	text: "Explicit one-shot reply.",
	sessionId: firstId,
});
assert.equal(
	(await callTool(broker.client, "chat-b", "sessions")).binding,
	secondId,
);
assert.deepEqual(assistantTexts(first).slice(-1), ["Explicit one-shot reply."]);

const selected = await callTool(broker.client, "chat-b", "sessions", {
	sessionId: firstId,
});
assert.equal(selected.binding, secondId);
assert.deepEqual(
	(selected.sessions as unknown[]).map((session) => record(session).id),
	[firstId],
);
await callTool(broker.client, "chat-b", "init", { sessionId: firstId });
assert.equal(
	(await callTool(broker.client, "chat-b", "sessions")).binding,
	firstId,
);

await stopBroker(broker);
await Promise.all([firstRun, secondRun]);
broker = await startBroker(agentDir);
firstRun = (await startProvider(first, "Reconnect the first session.")).run;
secondRun = (await startProvider(second, "Reconnect the second session.")).run;
assert.equal(
	record((await callTool(broker.client, "chat-a", "init")).session).id,
	firstId,
);
assert.equal(
	(await callTool(broker.client, "chat-b", "sessions")).binding,
	firstId,
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
