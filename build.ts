import { rm } from "node:fs/promises";

await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: ["./index.ts"],
	outdir: "./dist",
	target: "node",
	format: "esm",
	// A .js ESM entry can be imported natively by jiti, bypassing Pi's virtual
	// host modules when development peers exist. Keep the bundle in Pi's
	// TypeScript loader so classes, registries, and cleanup hooks stay shared.
	naming: "[dir]/[name].ts",
	plugins: [{
		name: "pi-host-modules",
		setup(build) {
			// Pi supplies these exact entrypoints. Bundle submodules such as the
			// Responses converter: the loader cannot resolve them in isolated installs.
			build.onResolve({ filter: /^@earendil-works\/pi-(ai|coding-agent|agent-core)$/ }, ({ path }) => ({ path, external: true }));
		},
	}],
});
if (!result.success) throw new AggregateError(result.logs, "Extension build failed");
