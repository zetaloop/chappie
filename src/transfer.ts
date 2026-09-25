import { hostname } from "node:os";
import { basename } from "node:path";
import {
	formatSize,
	type ToolDefinition,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as z from "zod";
import {
	type TransferDetails,
	type TransferInput,
	transferDescription,
	transferFiles,
	transferInput,
} from "./files.ts";

const parameters = Type.Unsafe<TransferInput>(z.toJSONSchema(transferInput));

export const transfer = {
	name: "transfer",
	label: "transfer",
	description: transferDescription,
	parameters,
	execute(_id, args, signal, update, context) {
		return transferFiles(
			args,
			{
				id: context.sessionManager.getSessionId(),
				cwd: context.cwd,
				mutate: withFileMutationQueue,
			},
			signal,
			(details) => update?.({ content: [], details }),
		);
	},
	renderCall(args, theme, context) {
		const device = context.state.device ?? hostname();
		const from = args.files
			? "ChatGPT"
			: args.from
				? (context.state.from ?? "Session")
				: device;
		const to =
			args.files || args.from
				? device
				: (context.state.to ?? (args.to ? "Session" : "ChatGPT"));
		const header =
			context.lastComponent instanceof Text
				? context.lastComponent
				: new Text("", 0, 0);
		header.setText(theme.fg("toolTitle", theme.bold(`${from} → ${to}`)));
		context.state.header = header;
		return header;
	},
	renderResult(result, _options, theme, context) {
		const details = result.details;
		if (!details) {
			const text = result.content
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("\n");
			return new Text(
				theme.fg(context.isError ? "error" : "toolOutput", text),
				0,
				0,
			);
		}
		const args = context.args;
		context.state.device = details.device;
		context.state.to = details.to?.device ?? "ChatGPT";
		context.state.from = details.from?.device;
		const from = args.files
			? "ChatGPT"
			: (details.from?.device ?? details.device);
		const to =
			args.files || args.from
				? details.device
				: (details.to?.device ?? "ChatGPT");
		context.state.header?.setText(
			theme.fg("toolTitle", theme.bold(`${from} → ${to}`)),
		);
		const lines =
			details.resources.length > 0
				? details.resources.map((resource, index) => {
						const source = displayPath(args.paths?.[index] ?? resource.name);
						const destination = args.to?.paths[index];
						return `${destination ? `${source} → ${destination}` : source}  ${theme.fg("dim", formatSize(resource.size))}`;
					})
				: details.files.length > 0
					? details.files.map((file, index) => {
							const source = args.to
								? args.paths?.[index]
								: (args.from?.paths[index] ?? args.files?.[index]?.file_name);
							const path = source
								? `${displayPath(source)} → ${file.path}`
								: file.path;
							return "error" in file
								? theme.fg("error", `${path}\n${file.error}`)
								: `${path}  ${theme.fg("dim", formatSize(file.bytes))}`;
						})
					: (args.paths ?? []).map((path, index) =>
							args.to?.paths[index]
								? `${displayPath(path)} → ${args.to.paths[index]}`
								: displayPath(path),
						);
		return new Text(lines.join("\n"), 0, 0);
	},
} satisfies ToolDefinition<
	typeof parameters,
	TransferDetails,
	{ header?: Text; device?: string; to?: string; from?: string | undefined }
>;

function displayPath(path: string): string {
	return path.startsWith("chappie://")
		? decodeURIComponent(basename(new URL(path).pathname))
		: path;
}
