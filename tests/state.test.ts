import { expect, test } from "bun:test";
import { NATIVE_COMPACTION_TYPE, readNativeCompactionDetails } from "../index";
import { validateCompactedOutput } from "../protocol";
const checkpoint = { type: "compaction", encrypted_content: "opaque" };
const base = { type: NATIVE_COMPACTION_TYPE, provider: "openai", api: "openai-responses", model: "fixture", output: [checkpoint] };

test("legacy metadata stays inspectable but never gains prefix coverage", () => {
	for (const version of [1, 2] as const) {
		const result = readNativeCompactionDetails({ ...base, version, protocol: "responses-compact" })!;
		expect(result.version).toBe(version);
		expect(result.coverage).toBeUndefined();
	}
	expect(readNativeCompactionDetails({ ...base, version: "3", protocol: "responses-compact" })).toBeUndefined();
	expect(readNativeCompactionDetails({ ...base, version: 3, protocol: "responses-compact" })).toBeUndefined();
});

test("malformed and oversized native windows fail before persistence/replay", () => {
	for (const item of [{}, { type: "unknown" }, { type: "message", role: "user", content: [{}] }, { type: "function_call", call_id: "x" }, { type: "reasoning" }, { type: "custom_tool_call_output", call_id: "x", output: 4 }]) {
		expect(() => validateCompactedOutput({ output: [item, checkpoint] })).toThrow();
	}
	expect(() => validateCompactedOutput({ output: [{ ...checkpoint, encrypted_content: "x".repeat(2 * 1024 * 1024) }] })).toThrow("2 MiB");
	expect(() => validateCompactedOutput({ output: [{ type: "message", role: "user", content: "x".repeat(1024 * 1024) }, ...Array.from({ length: 8 }, () => ({ type: "message", role: "user", content: "x".repeat(1024 * 1024) })), checkpoint] })).toThrow("8 MiB");
	expect(readNativeCompactionDetails({ ...base, version: 2, protocol: "responses-compact", output: [{ type: "compaction", encrypted_content: "" }] })).toBeUndefined();
});
