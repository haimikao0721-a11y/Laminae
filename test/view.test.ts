import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutCards } from "../web/layout.ts";
import { niceStep } from "../web/ruler.ts";
import { tickSet } from "../web/gridzoom.ts";

const W = 196;
const H = 24;

test("layoutCards：同一目录进同一张卡片，节点不重叠、都在画布内", () => {
  const ids = ["src/a.js", "src/b.js", "lib/x.js", "lib/y.js", "lib/z.js", "index.js", "test/t.js"];
  const lay = layoutCards(ids, 1000, W, H);
  assert.deepEqual(
    lay.cards.map((c) => c.title).sort(),
    ["lib", "src", "test", "（根目录）"].sort(),
  );
  for (let i = 0; i < ids.length; i++) {
    assert.ok(lay.x[i]! >= 0 && lay.x[i]! + W <= lay.width, `${ids[i]} 横向在画布内`);
    assert.ok(lay.y[i]! >= 0 && lay.y[i]! + H <= lay.height, `${ids[i]} 纵向在画布内`);
  }
  // 任意两个节点的矩形不相交
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const apart = lay.x[i]! + W <= lay.x[j]! || lay.x[j]! + W <= lay.x[i]! || lay.y[i]! + H <= lay.y[j]! || lay.y[j]! + H <= lay.y[i]!;
      assert.ok(apart, `${ids[i]} 与 ${ids[j]} 不应重叠`);
    }
  }
  // 同一目录的节点落在它那张卡片里
  const lib = lay.cards.find((c) => c.title === "lib")!;
  for (const id of ["lib/x.js", "lib/y.js", "lib/z.js"]) {
    const k = ids.indexOf(id);
    assert.ok(lay.x[k]! >= lib.x && lay.x[k]! + W <= lib.x + lib.w && lay.y[k]! >= lib.y && lay.y[k]! + H <= lib.y + lib.h, `${id} 在 lib 卡片里`);
  }
});

test("layoutCards：列数随可用宽度变化；很窄时退成一列；空输入不崩", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `d${i}/f.js`);
  const wide = layoutCards(ids, 1400, W, H);
  const narrow = layoutCards(ids, 100, W, H);
  assert.ok(wide.width > narrow.width, "宽的更宽");
  assert.ok(wide.height < narrow.height, "宽的更矮，因为列数多");
  assert.equal(new Set(narrow.cards.map((c) => c.x)).size, 1, "很窄时只有一列");

  const empty = layoutCards([], 800, W, H);
  assert.equal(empty.cards.length, 0);
  assert.ok(Number.isFinite(empty.width) && Number.isFinite(empty.height));
});

test("niceStep：取 1、2、5 × 10^n，且不小于要求的间隔", () => {
  assert.equal(niceStep(0.3), 1);
  assert.equal(niceStep(1), 1);
  assert.equal(niceStep(1.1), 2);
  assert.equal(niceStep(3), 5);
  assert.equal(niceStep(6), 10);
  assert.equal(niceStep(11), 20);
  assert.equal(niceStep(180), 200);
  assert.equal(niceStep(5000), 5000);
  for (const g of [1.5, 4, 7, 33, 90, 410, 12345]) assert.ok(niceStep(g) >= g, `niceStep(${g}) 不小于 ${g}`);
});

test("tickSet：每 step 一个；最后一格离上一个刻度太近就不标", () => {
  assert.deepEqual([...tickSet(26, 10)], [0, 10, 20, 25], "25 离 20 有 5，够远，标出来");
  assert.deepEqual([...tickSet(25, 10)], [0, 10, 20], "24 离 20 只差 4，不标");
  assert.deepEqual([...tickSet(1, 10)], [0]);
  assert.deepEqual([...tickSet(0, 10)], []);
  assert.equal(tickSet(1000, 100).has(900), true);
});
