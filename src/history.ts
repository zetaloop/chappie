export function historyText(entries: readonly unknown[]): string {
	return JSON.stringify(
		entries,
		function (this: Record<string, unknown>, key: string, value: unknown) {
			if (
				this.role === "toolResult" &&
				(key === "details" || key === "nestedCalls")
			)
				return undefined;
			if (
				key === "data" &&
				(typeof this.mime === "string" || typeof this.mimeType === "string")
			)
				return undefined;
			if (
				(key === "uri" ||
					key === "url" ||
					key === "imageUrl" ||
					key === "image_url") &&
				typeof value === "string" &&
				value.startsWith("data:")
			)
				return undefined;
			return value;
		},
		2,
	);
}
