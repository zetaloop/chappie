import { access } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionEntry,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as z from "zod";
import type { Activity } from "./activity.ts";
import { readConfig } from "./config.ts";
import { historyResult } from "./history.ts";
import type { Host } from "./host.ts";
import type { SessionInput } from "./ipc.ts";
import { localDeliveries, localTools } from "./local.ts";
import { createChappieProvider } from "./provider.ts";
import { Session } from "./session.ts";
import { transfer } from "./transfer.ts";

interface Notice extends Activity {
	message: string;
	type: "info" | "warning" | "error";
}

export default async function chappie(pi: ExtensionAPI): Promise<void> {
	const config = await readConfig();
	let context: ExtensionContext | undefined;
	let model: ExtensionContext["model"];
	let inputCursor: string | null = null;

	const current = (): ExtensionContext => {
		if (!context) throw new Error("Session has not started");
		return context;
	};

	const host: Host = {
		describe() {
			const ctx = current();
			const name = pi.getSessionName();
			return {
				id: ctx.sessionManager.getSessionId(),
				agent: "pi",
				cwd: ctx.cwd,
				device: hostname(),
				...(model ? { model: `${model.provider}/${model.id}` } : {}),
				...(name ? { name } : {}),
			};
		},
		active: () => model?.provider === "chappie",
		isIdle: () => current().isIdle(),
		async inspect() {
			const active = new Set(pi.getActiveTools());
			const path = resolve(getAgentDir(), "AGENTS.md");
			let globalAgents: { path: string } | undefined;
			try {
				await access(path);
				globalAgents = { path };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			return {
				tools: pi
					.getAllTools()
					.filter((tool) => active.has(tool.name))
					.map((tool) => ({ ...tool, parameters: { ...tool.parameters } })),
				skills: pi
					.getCommands()
					.filter((command) => command.source === "skill"),
				...(globalAgents ? { globalAgents } : {}),
			};
		},
		async history(range) {
			const manager = current().sessionManager;
			return historyResult(manager.getBranch(), manager.getSessionId(), range);
		},
		inputs(): SessionInput[] {
			const manager = current().sessionManager;
			const leafId = manager.getLeafId();
			if (leafId === inputCursor) return [];
			const entries: SessionEntry[] = [];
			let entry = manager.getLeafEntry();
			while (entry && entry.id !== inputCursor) {
				entries.push(entry);
				entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined;
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
				inputs.push({
					id: entry.id,
					sessionId: manager.getSessionId(),
					message: entry.message as UserMessage,
				});
			}
			return inputs;
		},
		resetInputs() {
			inputCursor = context?.sessionManager.getLeafId() ?? null;
		},
		wake() {
			pi.sendMessage(
				{ customType: "chappie.request", content: "", display: false },
				{ triggerTurn: true },
			);
		},
		abort: () => current().abort(),
		notify(message, type, activity) {
			pi.appendEntry<Notice>("chappie.notice", { message, type, ...activity });
		},
		toolsChanged: () => updateTools(),
		mutate: withFileMutationQueue,
	};

	const session = new Session(host, config);
	const tools = localTools(session);
	const names = new Set(tools.map((tool) => tool.name));
	let exposed: string | undefined;
	function updateTools(): void {
		const desired = session.active
			? ["transfer"]
			: session.localTools
				? [...names]
				: [];
		const key = desired.join(",");
		if (key === exposed) return;
		exposed = key;
		pi.setActiveTools([
			...pi.getActiveTools().filter((name) => !names.has(name)),
			...desired,
		]);
	}
	const update = (ctx: ExtensionContext, selected = ctx.model): void => {
		context = ctx;
		model = selected;
		session.update();
		updateTools();
	};

	pi.registerEntryRenderer<Notice>(
		"chappie.notice",
		({ data }, _options, theme) => {
			if (!data) return;
			return new Text(
				theme.fg(data.type === "info" ? "dim" : data.type, data.message),
				1,
				0,
			);
		},
	);
	pi.on("session_start", (_event, ctx) => update(ctx));
	pi.on("model_select", (event, ctx) => update(ctx, event.model));
	pi.on("session_info_changed", (_event, ctx) => update(ctx));
	pi.on("session_tree", (event, ctx) => {
		context = ctx;
		if (host.active()) {
			session.resetInputs();
			inputCursor = event.newLeafId;
		}
		session.historyChanged();
	});
	// Pi persists messages after message_end handlers finish.
	pi.on("message_start", (_event, ctx) => {
		context = ctx;
		session.historyChanged();
	});
	pi.on("tool_call", (_event, ctx) => {
		context = ctx;
		session.historyChanged();
	});
	pi.on("session_compact", (_event, ctx) => {
		context = ctx;
		session.historyChanged();
	});
	pi.on("context", (event) => ({
		messages: host.active()
			? []
			: event.messages.filter(
					(message) =>
						message.role !== "custom" ||
						message.customType !== "chappie.request",
				),
	}));
	pi.on("turn_end", (event, ctx) => {
		context = ctx;
		session.complete(event.message, event.toolResults);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		context = ctx;
		await session.settled();
	});
	pi.on("session_shutdown", () => session.close());
	for (const tool of tools) {
		if (tool.name === "transfer") continue;
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: Type.Unsafe<Record<string, unknown>>(
				z.toJSONSchema(tool.parameters),
			),
			async execute(_id, args, signal, update) {
				const result = await tool.execute(args, signal, (result) =>
					update?.({ ...result, details: result.details }),
				);
				return { ...result, details: result.details };
			},
		});
	}
	pi.registerTool({
		...transfer,
		async execute(_id, args, signal, update) {
			const result = await session.transfer(args, signal, (details) =>
				update?.({ content: [], details }),
			);
			return {
				...result,
				content: [...result.content, ...localDeliveries(session)],
			};
		},
	});
	pi.registerProvider(createChappieProvider((output) => session.start(output)));
}
