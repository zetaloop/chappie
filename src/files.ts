import * as z from "zod";

export const transferFile = z.object({
	file_id: z.string().describe("Host file identifier"),
	download_url: z.string().describe("Host-provided download URL"),
	file_name: z.string().optional(),
	mime_type: z.string().optional(),
});

export const transferInput = z.object({
	paths: z
		.array(z.string())
		.min(1)
		.describe(
			"Destination paths for import; source paths or chappie:// image references for export or session copies",
		),
	files: z
		.array(transferFile)
		.min(1)
		.optional()
		.describe(
			"ChatGPT files paired with paths in order; omit for session sources",
		),
	to: z
		.object({
			sessionId: z.string().describe("Destination session"),
			paths: z
				.array(z.string())
				.min(1)
				.describe("Destinations paired with source paths in order"),
		})
		.optional(),
	overwrite: z.boolean().optional().describe("Overwrite existing target files"),
});

export type TransferInput = z.infer<typeof transferInput>;

export const transferDescription =
	"Copy ChatGPT files into session paths with files, or copy session files to another session with to. Otherwise, return resource links for paths or Chappie image references.";
