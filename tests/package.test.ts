import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
