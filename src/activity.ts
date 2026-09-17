export interface Source {
	chatId: string;
	requestId?: string;
}

export interface Activity extends Partial<Source> {
	event?: string;
	initialization?: "explicit" | "implicit";
}

export function source(chatId: string, requestId: unknown): Source {
	return {
		chatId,
		...(typeof requestId === "string" ? { requestId } : {}),
	};
}

export function chatLabel({ chatId, requestId }: Source): string {
	const workflow = requestId?.match(/^wfr_([^/]+)\//)?.[1];
	return `ChatGPT ${chatId.slice(-4)}${workflow ? `(${workflow.slice(-4)})` : ""}`;
}
