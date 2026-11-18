import * as z from "zod";

export type ConnectionStatus =
	| "connecting"
	| "local"
	| "remote"
	| "disconnected";

export const connectionLabel = z.enum([
	"..",
	"xx",
	"ok",
	"lo",
	"o↑",
	"o↓",
	"o↕",
	"l↑",
	"l↓",
	"l↕",
]);
export type ConnectionLabel = z.infer<typeof connectionLabel>;

export class ConnectionIndicator {
	readonly #show: (label: ConnectionLabel | undefined) => void;
	#up = 0;
	#down = 0;
	#timer?: NodeJS.Timeout;
	label: ConnectionLabel | undefined;

	constructor(show: (label: ConnectionLabel | undefined) => void) {
		this.#show = show;
	}

	update(
		status: ConnectionStatus | undefined,
		outgoing: boolean,
		incoming: boolean,
	): void {
		clearTimeout(this.#timer);
		let label: ConnectionLabel | undefined;
		if (status === "local" || status === "remote") {
			const now = performance.now();
			if (outgoing) this.#up ||= now + 120;
			else if (this.#up <= now) this.#up = 0;
			if (incoming) this.#down ||= now + 120;
			else if (this.#down <= now) this.#down = 0;
			const arrow = this.#up
				? this.#down
					? "↕"
					: "↑"
				: this.#down
					? "↓"
					: undefined;
			label = arrow
				? `${status === "local" ? "o" : "l"}${arrow}`
				: status === "local"
					? "ok"
					: "lo";
			const next = Math.min(
				outgoing || !this.#up ? Infinity : this.#up,
				incoming || !this.#down ? Infinity : this.#down,
			);
			if (Number.isFinite(next))
				this.#timer = setTimeout(
					() => this.update(status, outgoing, incoming),
					Math.ceil(next - now),
				).unref();
		} else {
			this.#up = this.#down = 0;
			label =
				status === "connecting"
					? ".."
					: status === "disconnected"
						? "xx"
						: undefined;
		}
		if (this.label !== label) {
			this.label = label;
			this.#show(label);
		}
	}
}
