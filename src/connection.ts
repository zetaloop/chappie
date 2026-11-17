import * as z from "zod";

export const connectionStatus = z.enum([
	"connecting",
	"local",
	"remote",
	"disconnected",
]);

export type ConnectionStatus = z.infer<typeof connectionStatus>;

export const connectionLabels: Record<ConnectionStatus, string> = {
	connecting: "..",
	local: "ok",
	remote: "lo",
	disconnected: "xx",
};
