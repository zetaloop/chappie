import type { Rpc } from "@opencode/plugin/rpc";
import * as z from "zod";
import { connectionStatus } from "./connection.ts";

export const connectionRpc = {
	id: "chappie",
	methods: {
		status: {
			input: z.object({ sessionID: z.string() }),
			output: connectionStatus.nullable(),
		},
	},
	events: {
		status: {
			schema: z.object({
				sessionID: z.string(),
				status: connectionStatus.nullable(),
			}),
		},
	},
} satisfies Rpc.PortableDefinition;
