import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeliveryRecord } from "./delivery.ts";
import type { QuestionAnswer, QuestionRecord } from "./questions.ts";

interface StateFile {
	bindings?: Record<string, string>;
	joins?: Record<string, string[]>;
	workflows?: Record<string, string>;
	deliveries?: DeliveryRecord[];
	questions?: QuestionRecord[];
}

export class State {
	readonly #path: string;
	readonly #temporaryPath: string;
	readonly #bindings = new Map<string, string>();
	readonly #joins = new Map<string, Set<string>>();
	readonly #workflows = new Map<string, string>();
	readonly #deliveries = new Map<string, DeliveryRecord>();
	readonly #questions = new Map<string, QuestionRecord>();
	#writes = Promise.resolve();

	constructor(agentDir: string) {
		this.#path = join(agentDir, "chappie.state.json");
		this.#temporaryPath = `${this.#path}.tmp`;
	}

	async load(): Promise<void> {
		let contents: string;
		try {
			contents = await readFile(this.#path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const state = JSON.parse(contents) as StateFile;
		for (const [chatId, sessionId] of Object.entries(state.bindings ?? {})) {
			if (typeof sessionId === "string") this.#bindings.set(chatId, sessionId);
		}
		for (const [chatId, ids] of Object.entries(state.joins ?? {})) {
			this.#joins.set(chatId, new Set(ids));
		}
		for (const [chatId, id] of Object.entries(state.workflows ?? {})) {
			this.#workflows.set(chatId, id);
		}
		for (const delivery of state.deliveries ?? []) {
			if (delivery?.id) this.#deliveries.set(delivery.id, delivery);
		}
		for (const question of state.questions ?? [])
			this.#questions.set(question.id, question);
	}

	workflow(chatId: string): string | undefined {
		return this.#workflows.get(chatId);
	}

	setWorkflow(chatId: string, id: string): Promise<void> {
		this.#workflows.set(chatId, id);
		return this.#save();
	}

	binding(chatId: string): string | undefined {
		return this.#bindings.get(chatId);
	}

	bindingCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const sessionId of this.#bindings.values()) {
			counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
		}
		return counts;
	}

	async join(
		chatId: string,
		sessionId: string,
		workflowId: string | undefined,
	): Promise<boolean> {
		const changed = this.#bindings.get(chatId) !== sessionId;
		const workflows = changed
			? new Set<string>()
			: (this.#joins.get(chatId) ?? new Set<string>());
		if (!changed && (!workflowId || workflows.has(workflowId))) return false;
		this.#bindings.set(chatId, sessionId);
		if (workflowId) workflows.add(workflowId);
		this.#joins.set(chatId, workflows);
		await this.#save();
		return true;
	}

	deliveries(chatId: string): DeliveryRecord[] {
		return [...this.#deliveries.values()].filter(
			(delivery) => delivery.chatId === chatId,
		);
	}

	addDelivery(delivery: DeliveryRecord): Promise<void> {
		this.#deliveries.set(delivery.id, delivery);
		return this.#save();
	}

	question(chatId: string, id: string): QuestionRecord {
		const question = this.#questions.get(id);
		if (!question || question.chatId !== chatId)
			throw new Error("Question not found in this ChatGPT conversation");
		return question;
	}

	async addQuestion(question: QuestionRecord): Promise<void> {
		this.#questions.set(question.id, question);
		await this.#save();
	}

	async answer(
		chatId: string,
		id: string,
		answer: QuestionAnswer,
	): Promise<QuestionRecord> {
		const question = this.question(chatId, id);
		const selections = [...new Set(answer.selections)].sort((a, b) => a - b);
		if (selections.some((index) => !question.options[index]))
			throw new Error("Unknown question option");
		if (!question.allowMultiple && selections.length > 1)
			throw new Error("Select one option");
		if (answer.skipped && (selections.length > 0 || answer.text))
			throw new Error("A skipped question cannot include an answer");
		if (!answer.skipped && selections.length === 0 && !answer.text)
			throw new Error("Select an option or enter an answer");
		const value: QuestionAnswer = {
			selections,
			text: answer.text,
			...(answer.skipped ? { skipped: true } : {}),
		};
		if (JSON.stringify(question.answer) === JSON.stringify(value))
			return question;
		const updated = { ...question, answer: value, delivered: false };
		await this.addQuestion(updated);
		return updated;
	}

	answers(chatId: string): QuestionRecord[] {
		return [...this.#questions.values()].filter(
			(question) =>
				question.chatId === chatId && question.answer && !question.delivered,
		);
	}

	async acknowledge(
		deliveries: DeliveryRecord[],
		answers: QuestionRecord[],
		signal: AbortSignal,
	): Promise<void> {
		if (deliveries.length === 0 && answers.length === 0) return;
		signal.throwIfAborted();
		const delivered = new Map(
			answers.map((question) => [question, { ...question, delivered: true }]),
		);
		for (const delivery of deliveries) this.#deliveries.delete(delivery.id);
		for (const [question, updated] of delivered) {
			if (this.#questions.get(question.id) === question)
				this.#questions.set(question.id, updated);
		}
		try {
			await this.#save();
			signal.throwIfAborted();
		} catch (error) {
			for (const delivery of deliveries)
				this.#deliveries.set(delivery.id, delivery);
			for (const [question, updated] of delivered) {
				if (this.#questions.get(question.id) === updated)
					this.#questions.set(question.id, question);
			}
			await this.#save();
			throw error;
		}
	}

	#save(): Promise<void> {
		const saved = this.#writes.then(async () => {
			const bindings = Object.fromEntries(this.#bindings);
			const joins = Object.fromEntries(
				[...this.#joins].map(([chatId, ids]) => [chatId, [...ids]]),
			);
			const workflows = Object.fromEntries(this.#workflows);
			await writeFile(
				this.#temporaryPath,
				`${JSON.stringify({ bindings, joins, workflows, deliveries: [...this.#deliveries.values()], questions: [...this.#questions.values()] }, null, 2)}\n`,
				{
					mode: 0o600,
				},
			);
			await rename(this.#temporaryPath, this.#path);
		});
		this.#writes = saved.catch(() => {});
		return saved;
	}
}
