import type { Plugin } from "@opencode/plugin/tui";
import { type JSX, jsx } from "@opentui/solid/jsx-runtime";
import { createEffect, createSignal, on, onCleanup } from "solid-js";
import type { ConnectionLabel } from "./connection.ts";
import { connectionRpc } from "./opencode-rpc.ts";

export default {
	id: "chappie",
	setup(context) {
		context.ui.slot({
			append: "prompt.footer.status",
			render(input) {
				const rpc = context.client.rpc(connectionRpc);
				const [status, setStatus] = createSignal<ConnectionLabel | null>(null);
				let request = 0;
				const load = (sessionID: string) => {
					const current = ++request;
					const directory =
						context.data.session.get(sessionID)?.location.directory;
					void rpc
						.status(
							{ sessionID },
							directory ? { location: { directory } } : undefined,
						)
						.then(
							(value) => {
								if (current === request) setStatus(value);
							},
							() => {
								if (current === request) setStatus("xx");
							},
						);
				};
				onCleanup(
					rpc.events.on("status", (event) => {
						if (event.data.sessionID !== input.sessionID) return;
						request++;
						setStatus(event.data.status);
					}),
				);
				onCleanup(
					context.data.on("server.connected", () => {
						if (input.sessionID) load(input.sessionID);
					}),
				);
				onCleanup(() => {
					request++;
				});
				createEffect(
					on(
						() => input.sessionID,
						(sessionID) => {
							request++;
							setStatus(null);
							if (sessionID) load(sessionID);
						},
					),
				);
				return jsx("text", {
					flexShrink: 0,
					wrapMode: "none",
					get visible() {
						return status() !== null;
					},
					get children() {
						return `chp:${status() ?? ""}`;
					},
					get fg() {
						const value = status();
						const colors = context.theme.text;
						return value === "xx"
							? colors.feedback.error.base
							: value === ".."
								? colors.muted
								: colors.feedback.success.base;
					},
				} satisfies JSX.IntrinsicElements["text"]);
			},
		});
	},
} satisfies Plugin.Definition;
