export {};

const result = await Bun.build({
	entrypoints: ["./index.ts"],
	outdir: "./dist",
	target: "node",
	format: "esm",
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
