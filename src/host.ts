import type { Activity, Source } from "./activity.ts";
import type { FileMutation } from "./files.ts";
import type { HistoryRange, HistoryResult } from "./history.ts";
import type { SessionDescription, SessionInput } from "./ipc.ts";

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type Content = TextContent | ImageContent;

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolResultMessage {
	toolCallId: string;
	toolName: string;
	content: Content[];
	isError: boolean;
	details?: unknown;
}

export interface UserMessage {
	role: "user";
	content: string | Content[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (Content | ToolCall | { type: "thinking"; thinking: string })[];
	chappie?: Source;
}

export interface ToolInfo {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	sourceInfo?: unknown;
}

export interface SkillInfo {
	name: string;
	description?: string;
	sourceInfo?: unknown;
}

export interface Environment {
	tools: ToolInfo[];
	skills: SkillInfo[];
	globalAgents?: { path: string };
}

export interface Output {
	readonly message: AssistantMessage;
	readonly finished: Promise<void>;
	readonly closed: boolean;
	begin(): void;
	text(text: string): void;
	toolCalls(calls: ToolCall[]): void;
	done(reason?: "stop" | "toolUse"): void;
	fail(error: unknown, aborted?: boolean): void;
}

export interface Host {
	describe(): Omit<SessionDescription, "status">;
	active(): boolean;
	isIdle(): boolean;
	inspect(): Promise<Environment>;
	history(range: HistoryRange): Promise<HistoryResult>;
	inputs(): SessionInput[];
	resetInputs(): void;
	wake(): void | Promise<void>;
	abort(): void | Promise<void>;
	notify?(
		message: string,
		type: "info" | "warning" | "error",
		activity: Activity,
	): void;
	mutate?: FileMutation;
}
