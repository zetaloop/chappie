import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function chappi(pi: ExtensionAPI): void {
	pi.registerFlag("chappi", {
		description: "Serve Chappi over MCP",
		type: "boolean",
	});
}
