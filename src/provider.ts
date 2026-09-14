import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	createProvider,
	type Model,
	type StreamOptions,
} from "@earendil-works/pi-ai";

export class ProviderOutput {
	readonly stream: AssistantMessageEventStream;
	readonly message: AssistantMessage;
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
				this.fail(new Error("Chappi provider request was cancelled"), true);
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

export function createChappiProvider(
	start: (output: ProviderOutput, context: Context) => Promise<void>,
) {
	const stream = (
		model: Model<Api>,
		context: Context,
		options?: StreamOptions,
	) => {
		const output = new ProviderOutput(model, options?.signal);
		if (!output.closed) {
			queueMicrotask(() => {
				void start(output, context).catch((error: unknown) =>
					output.fail(error),
				);
			});
		}
		return output.stream;
	};

	return createProvider({
		id: "chappi",
		name: "Chappi",
		auth: {
			apiKey: {
				name: "Local Chappi",
				async resolve() {
					return { auth: { headers: {} }, source: "local" };
				},
			},
		},
		models: [
			{
				id: "chatgpt",
				name: "ChatGPT",
				api: "chappi",
				provider: "chappi",
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
