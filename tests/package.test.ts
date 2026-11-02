import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

for (const linker of ["hoisted", "isolated"]) test(`published package loads in Pi with ${linker} dependencies and no peers`, async () => {
	const root = resolve(import.meta.dir, "..");
	const directory = await mkdtemp(join(tmpdir(), "pi-provider-compaction-package-"));
	const env = { ...process.env, NODE_PATH: "", PI_CODING_AGENT_DIR: join(directory, "agent"), PI_OFFLINE: "1" };
	async function run(command: string[], cwd = directory) {
		const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		expect(exitCode, `${command.join(" ")}\n${stdout}\n${stderr}`).toBe(0);
		return stdout + stderr;
	}
	try {
		const archive = join(directory, "extension.tgz");
		await run([process.execPath, "run", "build"], root);
		await run([process.execPath, "pm", "pack", "--filename", archive], root);
		await writeFile(join(directory, "package.json"), JSON.stringify({
			private: true,
			dependencies: { "@nijaru/pi-provider-compaction": `file:${archive}` },
		}));
		await run([process.execPath, "install", "--production", "--omit=peer", "--ignore-scripts", "--linker", linker]);
		// Exercise the same bundled Node loader as the installed Pi CLI. A source
		// import in this checkout would silently use our development dependencies.
		const piRoot = join(root, "node_modules/@earendil-works/pi-coding-agent");
		const piPackage = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8"));
		const installedRoot = join(directory, "node_modules/@nijaru/pi-provider-compaction");
		const installed = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
		const output = await run([
			"node", join(piRoot, piPackage.bin.pi), "--offline", "--no-session",
			"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"--extension", join(installedRoot, installed.pi.extensions[0]),
			"--mode", "rpc",
		]);
		// Pi can exit successfully after reporting an extension load failure.
		expect(output).not.toContain("Failed to load extension");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60_000);

test("manifest entrypoint reuses Pi's host modules when development peers exist", async () => {
	const root = resolve(import.meta.dir, "..");
	const directory = await mkdtemp(join(tmpdir(), "pi-provider-compaction-startup-"));
	try {
		const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		const entrypoint = join(root, manifest.pi.extensions[0]);
		const resolutions = join(directory, "host-resolutions.jsonl");
		const preload = join(directory, "trace.mjs");
		await writeFile(resolutions, "");
		// Compiled ESM can bypass jiti's virtual modules and import a second Pi
		// graph from devDependencies. Observe resolution, not a timing threshold
		// or a rejection that would make jiti silently retry through its aliases.
		await writeFile(preload, `
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
registerHooks({ resolve(specifier, context, nextResolve) {
	if (context.parentURL === ${JSON.stringify(pathToFileURL(entrypoint).href)} && /^@earendil-works\\/pi-/.test(specifier)) {
		appendFileSync(${JSON.stringify(resolutions)}, JSON.stringify(specifier) + "\\n");
	}
	return nextResolve(specifier, context);
} });
`);
		const child = Bun.spawn([
			"node", "--import", preload,
			join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
			"--offline", "--no-session", "--no-extensions", "--no-skills",
			"--no-prompt-templates", "--no-themes", "--no-context-files",
			"--extension", entrypoint, "--mode", "rpc",
		], {
			cwd: directory,
			env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_OFFLINE: "1" },
			stdin: "ignore", stdout: "pipe", stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		expect(exitCode, stdout + stderr).toBe(0);
		expect(stdout + stderr).not.toContain("Failed to load extension");
		expect(await readFile(resolutions, "utf8")).toBe("");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);
