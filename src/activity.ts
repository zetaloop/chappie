export interface Source {
	clientId: string;
	label: string;
	requestId?: string;
}

export interface Activity extends Partial<Source> {
	event?: string;
	initialization?: "explicit" | "implicit";
}

export function source(
	clientId: string,
	requestId: unknown,
	label = "ChatGPT",
): Source {
	return {
		clientId,
		label,
		...(typeof requestId === "string" ? { requestId } : {}),
	};
}

export function sourceLabel({ clientId, label, requestId }: Source): string {
	const workflow = requestId?.match(/^wfr_([^/]+)\//)?.[1];
	return `${label} ${clientId.slice(-4)}${workflow ? `(${workflow.slice(-4)})` : ""}`;
}
