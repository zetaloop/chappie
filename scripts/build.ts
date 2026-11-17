import { copyFile, glob, rename, rm } from "node:fs/promises";
import { basename } from "node:path";
import { build } from "esbuild";
import packageJson from "../package.json" with { type: "json" };

await rm("dist", { recursive: true, force: true });
await build({
	entryPoints: [
		"src/cli.ts",
		"src/index.ts",
		"src/omp.ts",
		"src/opencode.ts",
		"src/opencode-tui.tsx",
		"src/terminal.ts",
	],
	outdir: "dist",
	bundle: true,
	splitting: true,
	format: "esm",
	jsx: "preserve",
	platform: "node",
	banner: {
		js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
	},
	target: "es2024",
	external: Object.keys(packageJson.peerDependencies),
});
await rename("dist/opencode-tui.js", "dist/opencode-tui.jsx");
for await (const source of glob("src/*.{md,json}")) {
	await copyFile(source, `dist/${basename(source)}`);
}
