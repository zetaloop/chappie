import { copyFile, glob } from "node:fs/promises";
import { basename } from "node:path";

for await (const source of glob("src/*.{md,html}")) {
	await copyFile(source, `dist/${basename(source)}`);
}
