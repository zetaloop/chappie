import { access } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import * as z from "zod";
import { getDirectory, readConfig } from "./config.ts";
import { historyResult } from "./history.ts";
import type { Host } from "./host.ts";
import { ipcEndpoint, type SessionInput } from "./ipc.ts";
import { localTools } from "./local.ts";
import { createMessage, ProviderOutput } from "./provider.ts";
import { Session } from "./session.ts";

export default async function chappie(omp: ExtensionAPI): Promise<void> {
	const config = await readConfig();
	let context: ExtensionContext | undefined;
	let inputCursor: string | null = null;
	let manager: SessionManager | undefined;
	let unsubscribe: (() => void) | undefined;
	const current = (): ExtensionContext => {
		if (!context) throw new Error("Session has not started");
		return context;
	};
	const host: Host = {
		describe() {
			const ctx = current();
			const name = ctx.sessionManager.getSessionName();
			return {
				id: ctx.sessionManager.getSessionId(),
				agent: "omp",
				cwd: ctx.cwd,
				device: hostname(),
				...(ctx.model
					? { model: `${ctx.model.provider}/${ctx.model.id}` }
					: {}),
				...(name ? { name } : {}),
			};
		},
		active: () => context?.model?.provider === "chappie",
		isIdle: () => current().isIdle(),
		async inspect() {
			const active = new Set(omp.getActiveTools());
			const path = resolve(getAgentDir(), "AGENTS.md");
			let globalAgents: { path: string } | undefined;
			try {
				await access(path);
				globalAgents = { path };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			return {
				tools: omp
					.getAllTools()
					.filter((tool) => active.has(tool.name))
					.map((tool) => ({ ...tool, parameters: toolWireSchema(tool) })),
				skills: omp
					.getCommands()
					.filter((command) => command.source === "skill"),
				...(globalAgents ? { globalAgents } : {}),
			};
		},
		async history(range) {
			const ctx = current();
			return historyResult(
				ctx.sessionManager.getBranch(),
				ctx.sessionManager.getSessionId(),
				range,
			);
		},
		inputs() {
			const store = current().sessionManager;
			const leafId = store.getLeafId();
			if (leafId === inputCursor) return [];
			const entries = [];
			let entry = store.getLeafEntry();
			while (entry && entry.id !== inputCursor) {
				entries.push(entry);
				entry = entry.parentId ? store.getEntry(entry.parentId) : undefined;
			}
			const changedBranch = inputCursor !== null && !entry;
			inputCursor = leafId;
			if (changedBranch) {
				session.resetInputs();
				return [];
			}
			const inputs: SessionInput[] = [];
			for (const entry of entries.reverse()) {
				if (entry.type !== "message" || entry.message.role !== "user") continue;
				const message = entry.message as UserMessage;
				inputs.push({ id: entry.id, sessionId: store.getSessionId(), message });
			}
			return inputs;
		},
		resetInputs() {
			inputCursor = context?.sessionManager.getLeafId() ?? null;
		},
		wake() {
			omp.sendMessage(
				{ customType: "chappie.request", content: "", display: false },
				{ triggerTurn: true, deliverAs: "nextTurn" },
			);
		},
		abort: () => current().abort(),
		notify(message, type, activity) {
			omp.appendEntry("chappie.notice", { message, type, ...activity });
			context?.ui.notify(message, type);
		},
		toolsChanged: () => {
			void updateTools();
		},
	};
	const session = new Session(host, config);
	const tools = localTools(session);
	const names = new Set(tools.map((tool) => tool.name));
	let exposed: string | undefined;
	async function updateTools(): Promise<void> {
		const desired = session.active
			? ["transfer"]
			: session.localTools
				? [...names]
				: [];
		const key = desired.join(",");
		if (key === exposed) return;
		exposed = key;
		await omp.setActiveTools([
			...omp.getActiveTools().filter((name) => !names.has(name)),
			...desired,
		]);
	}
	async function update(ctx: ExtensionContext): Promise<void> {
		context = ctx;
		if (manager !== ctx.sessionManager) {
			unsubscribe?.();
			manager = ctx.sessionManager as SessionManager;
			const store = manager;
			const append = store.appendModelChange;
			// OMP journals model selection after updating its live model.
			const record: typeof append = function (this: SessionManager, ...args) {
				const result = append.apply(this, args);
				session.update();
				void updateTools();
				return result;
			};
			store.appendModelChange = record;
			const renamed = store.onSessionNameChanged(() => session.update());
			unsubscribe = () => {
				renamed();
				if (store.appendModelChange === record)
					store.appendModelChange = append;
			};
		}
		session.update();
		await updateTools();
	}
	omp.on("session_start", (_event, ctx) => update(ctx));
	omp.on("session_switch", (_event, ctx) => update(ctx));
	omp.on("session_branch", (_event, ctx) => update(ctx));
	omp.on("session_tree", async (_event, ctx) => {
		await update(ctx);
		session.resetInputs();
		session.historyChanged();
	});
	omp.on("context", (event) => ({
		messages: host.active()
			? []
			: event.messages.filter(
					(message) =>
						message.role !== "custom" ||
						message.customType !== "chappie.request",
				),
	}));
	omp.on("message_start", (_event, ctx) => {
		context = ctx;
		session.historyChanged();
	});
	omp.on("message_end", (_event, ctx) => {
		context = ctx;
		session.historyChanged();
	});
	omp.on("session_compact", (_event, ctx) => {
		context = ctx;
		session.historyChanged();
	});
	omp.on("turn_end", (event, ctx) => {
		context = ctx;
		session.complete(event.message, event.toolResults);
	});
	omp.on("agent_end", async (_event, ctx) => {
		context = ctx;
		await session.settled();
	});
	omp.on("session_shutdown", () => {
		unsubscribe?.();
		session.close();
	});
	for (const tool of tools) {
		omp.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: z.toJSONSchema(tool.parameters),
			async execute(_id, args, signal, update) {
				const result = await tool.execute(args, signal, (result) =>
					update?.({ ...result, details: result.details }),
				);
				return { ...result, details: result.details };
			},
		});
	}
	const provider: ProviderConfig = {
		api: "chappie",
		baseUrl: config.connect ?? ipcEndpoint(getDirectory()),
		apiKey: "chappie",
		models: [
			{
				id: "chatgpt",
				name: "ChatGPT",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000_000,
				maxTokens: 1_000_000_000,
			},
		],
		streamSimple(model, _context, options) {
			const stream = createAssistantMessageEventStream();
			const output = new ProviderOutput(
				createMessage<AssistantMessage["stopReason"]>(model, "stop"),
				stream,
				options?.signal,
			);
			queueMicrotask(() => {
				void session
					.start(output)
					.catch((error: unknown) => output.fail(error));
			});
			return stream;
		},
	};
	omp.registerProvider("chappie", provider);
}
