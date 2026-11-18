import type { Rpc } from "@opencode/plugin/rpc";
import * as z from "zod";
import { connectionLabel } from "./connection.ts";

export const connectionRpc = {
	id: "chappie",
	methods: {
		status: {
			input: z.object({ sessionID: z.string() }),
			output: connectionLabel.nullable(),
		},
	},
	events: {
		status: {
			schema: z.object({
				sessionID: z.string(),
				status: connectionLabel.nullable(),
			}),
		},
	},
} satisfies Rpc.PortableDefinition;
