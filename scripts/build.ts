import { copyFile, glob, rm } from "node:fs/promises";
import { basename } from "node:path";
import { build } from "esbuild";
import packageJson from "../package.json" with { type: "json" };

await rm("dist", { recursive: true, force: true });
await build({
	entryPoints: ["src/cli.ts", "src/index.ts", "src/omp.ts", "src/opencode.ts"],
	outdir: "dist",
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "node",
	banner: {
		js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
	},
	target: "es2024",
	external: Object.keys(packageJson.peerDependencies),
});
for await (const source of glob("src/*.{md,html,json}")) {
	await copyFile(source, `dist/${basename(source)}`);
}
