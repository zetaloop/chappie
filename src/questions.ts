import * as z from "zod";

export const questionInstructions =
	"ask requests a question widget in ChatGPT; its result confirms creation of the request. Immediately call ask_assert with question.id to confirm loading. If the widget fails to load within 10 seconds, the assertion fails and records the question as skipped. Use an installed Pi interactive tool through call when an answer is needed. User answers arrive separately as webAnswer in normal tool results. Apply answers and revisions promptly; a user skip means proceed with available information. Supply header when useful and mark the preferred first option recommended: true. The widget provides custom input, skipping, and editing saved answers.";

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
	skipped: z.literal(true).optional().describe("The question was skipped"),
});

export const questionOutput = questionInput.extend({
	id: z.string().describe("Generated question ID for ask_assert"),
	sessionId: z.string(),
	cwd: z.string(),
	answer: answerInput.optional(),
	loaded: z.boolean().optional().describe("The widget has reported loading"),
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
