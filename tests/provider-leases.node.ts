// Run in V8: JavaScriptCore tail calls mask the original growing delegate chain.
import assert from "node:assert/strict";
import { leaseEffectiveProvider } from "../provider";

const model = { provider: "fixture" } as any;
const context = { messages: [] } as any;
const sentinel = {} as any;
const base = { id: "fixture", stream() { return sentinel; }, streamSimple() { return sentinel; } } as any;
const descriptors = Object.getOwnPropertyDescriptors(base);
// A second bundled module models Pi's uncached extension loading in another cwd.
const other = process.argv[2] ? await import(`data:text/javascript;base64,${process.argv[2]}`) : { leaseEffectiveProvider };
const acquire = (slot: number) => (slot === 0 ? leaseEffectiveProvider : other.leaseEffectiveProvider)(base, () => base, () => undefined)!;
const slots = [acquire(0), acquire(1)];
for (let index = 0; index < 20_000; index++) {
	const slot = index % 2;
	slots[slot]!.remove();
	slots[slot] = acquire(slot);
}
assert.equal(base.streamSimple(model, context), sentinel);
assert.equal(base.stream(model, context), sentinel);
slots[0]!.remove();
slots[1]!.remove();
assert.deepEqual(Object.getOwnPropertyDescriptors(base), descriptors);
