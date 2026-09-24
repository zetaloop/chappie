import {
	fromJsonSchema,
	type StandardSchemaV1,
	type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";

export type EncodedArgs = { data: string } & Record<string, unknown>;

export interface Encoded<T> {
	inputSchema: StandardSchemaWithJSON<EncodedArgs, EncodedArgs>;
	describe(description: string): string;
	parse(args: EncodedArgs): Promise<T>;
}

const base64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function encode(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

export function decode(data: string): string {
	if (data.length % 4 !== 0 || !base64.test(data)) {
		throw new Error("data must be standard padded base64");
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(
		Buffer.from(data, "base64"),
	);
}

// Replaces a tool's arguments with `data`: base64 of the UTF-8 JSON arguments.
// Fields in `plain` stay top-level, e.g. host-populated openai/fileParams.
export function encoded<S extends StandardSchemaWithJSON>(
	schema: S,
	plain: string[] = [],
): Encoded<StandardSchemaV1.InferOutput<S>> {
	const { $schema: _, ...original } = schema["~standard"].jsonSchema.input({
		target: "draft-2020-12",
	}) as Record<string, unknown> & {
		properties?: Record<string, unknown>;
		required?: string[];
	};
	const properties = { ...original.properties };
	for (const name of plain) delete properties[name];
	const encodedSchema = JSON.stringify({
		...original,
		properties,
		required: original.required?.filter((name) => !plain.includes(name)),
	});
	return {
		inputSchema: fromJsonSchema<EncodedArgs>({
			type: "object",
			properties: {
				data: {
					type: "string",
					contentEncoding: "base64",
					description: `Standard padded base64 of the UTF-8 JSON arguments object matching: ${encodedSchema}`,
				},
				...Object.fromEntries(
					plain.map((name) => [name, original.properties?.[name]]),
				),
			},
			required: [
				"data",
				...plain.filter((name) => original.required?.includes(name)),
			],
			additionalProperties: false,
		}),
		describe: (description) =>
			`${description} Arguments: put the base64-encoded UTF-8 JSON arguments in data${plain.length ? `; ${plain.join(", ")} stay unencoded` : ""}. Every text result is base64-encoded UTF-8; decode it before use.`,
		async parse({ data, ...rest }) {
			let value: unknown;
			try {
				value = JSON.parse(decode(data));
			} catch (error) {
				throw new Error(
					`Invalid data: ${error instanceof Error ? error.message : String(error)}. Encode the UTF-8 JSON arguments object as standard padded base64.`,
				);
			}
			if (typeof value !== "object" || value === null || Array.isArray(value))
				throw new Error("Invalid data: decoded JSON must be an object");
			const result = await schema["~standard"].validate({ ...value, ...rest });
			if (result.issues) {
				throw new Error(
					`Invalid arguments: ${result.issues
						.map(
							(issue) =>
								`${issue.path?.map((key) => (typeof key === "object" ? key.key : key)).join(".") || "(root)"}: ${issue.message}`,
						)
						.join("; ")}`,
				);
			}
			return result.value as StandardSchemaV1.InferOutput<S>;
		},
	};
}
