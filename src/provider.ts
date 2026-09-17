import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	createProvider,
	type Model,
	type StreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { Source } from "./activity.ts";

export class ProviderOutput {
	readonly stream: AssistantMessageEventStream;
	readonly message: AssistantMessage & { chappie?: Source };
	readonly finished: Promise<void>;
	#resolveFinished: () => void;
	#removeAbort?: () => void;
	#started = false;
	#closed = false;

	constructor(model: Model<Api>, signal?: AbortSignal) {
		this.stream = createAssistantMessageEventStream();
		this.message = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};
		const completion = Promise.withResolvers<void>();
		this.finished = completion.promise;
		this.#resolveFinished = completion.resolve;
		if (signal) {
			const abort = (): void =>
				this.fail(new Error("Chappie provider request was cancelled"), true);
			signal.addEventListener("abort", abort, { once: true });
			this.#removeAbort = () => signal.removeEventListener("abort", abort);
			if (signal.aborted) abort();
		}
	}

	get closed(): boolean {
		return this.#closed;
	}

	begin(): void {
		if (this.#started || this.#closed) return;
		this.#started = true;
		this.stream.push({ type: "start", partial: this.message });
	}

	text(text: string): void {
		if (this.#closed)
			throw new Error("Chappie provider response is already complete");
		this.begin();
		const contentIndex = this.message.content.length;
		const block = { type: "text" as const, text: "" };
		this.message.content.push(block);
		this.stream.push({
			type: "text_start",
			contentIndex,
			partial: this.message,
		});
		block.text = text;
		this.stream.push({
			type: "text_delta",
			contentIndex,
			delta: text,
			partial: this.message,
		});
		this.stream.push({
			type: "text_end",
			contentIndex,
			content: text,
			partial: this.message,
		});
	}

	toolCalls(calls: ToolCall[]): void {
		if (this.#closed)
			throw new Error("Chappie provider response is already complete");
		this.begin();
		for (const call of calls) {
			const contentIndex = this.message.content.length;
			const block: ToolCall = { ...call, arguments: {} };
			this.message.content.push(block);
			this.stream.push({
				type: "toolcall_start",
				contentIndex,
				partial: this.message,
			});
			block.arguments = call.arguments;
			this.stream.push({
				type: "toolcall_delta",
				contentIndex,
				delta: JSON.stringify(call.arguments),
				partial: this.message,
			});
			this.stream.push({
				type: "toolcall_end",
				contentIndex,
				toolCall: block,
				partial: this.message,
			});
		}
	}

	done(reason: "stop" | "toolUse" = "stop"): void {
		if (this.#closed) return;
		this.begin();
		this.message.stopReason = reason;
		this.stream.push({ type: "done", reason, message: this.message });
		this.#finish();
	}

	fail(error: unknown, aborted = false): void {
		if (this.#closed) return;
		this.begin();
		this.message.stopReason = aborted ? "aborted" : "error";
		this.message.errorMessage =
			error instanceof Error ? error.message : String(error);
		this.stream.push({
			type: "error",
			reason: this.message.stopReason,
			error: this.message,
		});
		this.#finish();
	}

	#finish(): void {
		this.#closed = true;
		this.#removeAbort?.();
		this.stream.end();
		this.#resolveFinished();
	}
}

export function createChappieProvider(
	start: (output: ProviderOutput) => Promise<void>,
) {
	const stream = (
		model: Model<Api>,
		_context: Context,
		options?: StreamOptions,
	) => {
		const output = new ProviderOutput(model, options?.signal);
		if (!output.closed) {
			queueMicrotask(() => {
				void start(output).catch((error: unknown) => output.fail(error));
			});
		}
		return output.stream;
	};

	return createProvider({
		id: "chappie",
		name: "Chappie",
		auth: {
			apiKey: {
				name: "Local Chappie",
				async resolve() {
					return { auth: { headers: {} }, source: "local" };
				},
			},
		},
		models: [
			{
				id: "chatgpt",
				name: "ChatGPT",
				api: "chappie",
				provider: "chappie",
				baseUrl: "",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000_000,
				maxTokens: 1_000_000_000,
			},
		],
		api: { stream, streamSimple: stream },
	});
}
