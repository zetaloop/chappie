import * as z from "zod";

export const questionInput = z.object({
	header: z
		.string()
		.trim()
		.min(1)
		.optional()
		.describe("Short topic label above the question, when useful"),
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
				title: z.string().trim().min(1).describe("Short choice label"),
				description: z
					.string()
					.optional()
					.describe("Brief consequence or tradeoff of this choice"),
				recommended: z
					.boolean()
					.optional()
					.describe("Show a Recommended badge; put this choice first"),
			}),
		)
		.default([])
		.describe(
			"Distinct choices, usually two or three. The widget provides custom input and skipping separately.",
		),
	allowMultiple: z
		.boolean()
		.default(false)
		.describe("Allow selecting several options"),
});

export const answerInput = z.object({
	selections: z.array(z.number().int().nonnegative()).default([]),
	text: z.string().trim().default(""),
	skipped: z
		.literal(true)
		.optional()
		.describe("The user skipped this question"),
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
				header: record.header,
				question: record.question,
				skipped: record.answer?.skipped,
				choices: record.answer?.selections.map(
					(index) => record.options[index],
				),
				text: record.answer?.text,
			},
		}),
	}));
}
