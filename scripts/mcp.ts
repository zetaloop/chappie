import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

interface PendingRequest {
	resolve(result: unknown): void;
	reject(error: Error): void;
}

export const requestMeta = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientInfo": {
		name: "chappi-verification",
		version: "1.0.0",
	},
	"io.modelcontextprotocol/clientCapabilities": {},
} as const;

export class McpClient {
	readonly #process: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<number, PendingRequest>();
	#nextId = 1;

	constructor(process: ChildProcessWithoutNullStreams) {
		this.#process = process;
		const lines = createInterface({ input: process.stdout });
		lines.on("line", (line) => {
			let response: JsonRpcResponse;
			try {
				response = JSON.parse(line) as JsonRpcResponse;
			} catch (cause) {
				this.#fail(new Error(`Non-JSON stdout: ${line}`, { cause }));
				return;
			}

			const pending = this.#pending.get(response.id);
			if (!pending) return;
			this.#pending.delete(response.id);
			if (response.error) {
				pending.reject(
					new Error(`${response.error.code}: ${response.error.message}`),
				);
			} else {
				pending.resolve(response.result);
			}
		});
		process.once("exit", (code, signal) => {
			if (this.#pending.size === 0) return;
			this.#fail(
				new Error(
					`MCP process exited before responding: code=${code} signal=${signal}`,
				),
			);
		});
	}

	request(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = this.#nextId++;
		const result = new Promise<unknown>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
		});
		this.#process.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			(error) => {
				if (!error) return;
				const pending = this.#pending.get(id);
				this.#pending.delete(id);
				pending?.reject(error);
			},
		);
		return result;
	}

	close(): void {
		this.#process.stdin.end();
	}

	#fail(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}
}
