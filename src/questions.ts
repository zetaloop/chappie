import * as z from "zod";

export const questionInput = z.object({
	question: z
		.string()
		.trim()
		.min(1)
		.describe("One focused question for the user"),
	context: z
		.string()
		.optional()
		.describe("Context to display above the choices"),
	options: z
		.array(
			z.object({
				title: z.string().trim().min(1),
				description: z.string().optional(),
			}),
		)
		.default([])
		.describe("Suggested answers; a free-text field is always available"),
	allowMultiple: z
		.boolean()
		.default(false)
		.describe("Allow selecting several options"),
});

export const answerInput = z.object({
	selections: z.array(z.number().int().nonnegative()).default([]),
	text: z.string().trim().default(""),
});

export const questionOutput = questionInput.extend({
	id: z.string(),
	sessionId: z.string(),
	cwd: z.string(),
	answer: answerInput.optional(),
});

export type QuestionInput = z.infer<typeof questionInput>;
export type QuestionAnswer = z.infer<typeof answerInput>;
export type Question = z.infer<typeof questionOutput>;

export interface QuestionRecord extends Question {
	chatId: string;
	delivered: boolean;
}

export function questionView(record: QuestionRecord): Question {
	const { chatId: _chatId, delivered: _delivered, ...question } = record;
	return question;
}

export function answerContent(records: QuestionRecord[]) {
	return records.map((record) => ({
		type: "text" as const,
		text: JSON.stringify({
			webAnswer: {
				questionId: record.id,
				sessionId: record.sessionId,
				cwd: record.cwd,
				question: record.question,
				choices: record.answer?.selections.map(
					(index) => record.options[index],
				),
				text: record.answer?.text,
			},
		}),
	}));
}
