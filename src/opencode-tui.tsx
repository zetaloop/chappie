import type { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
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
				return (
					<Show when={status()}>
						{(value) => (
							<text
								flexShrink={0}
								wrapMode="none"
								fg={
									value() === "xx"
										? context.theme.text.feedback.error.base
										: value() === ".."
											? context.theme.text.muted
											: context.theme.text.feedback.success.base
								}
							>
								{`chp:${value()}`}
							</text>
						)}
					</Show>
				);
			},
		});
	},
} satisfies Plugin.Definition;
