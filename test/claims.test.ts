import { test } from "node:test";
import assert from "node:assert/strict";
import { loadClaims, parseClaims } from "../src/claims.ts";
import { SKILL_ROOT } from "./helpers.ts";
import path from "node:path";

const ok = {
  id: "a",
  file: "README.md",
  locator: "(\\d+) 个",
  fact: { type: "count-files", glob: "x/*" },
};

test("parseClaims：合法的说法通过，label 缺省取 id", () => {
  const [c] = parseClaims([ok]);
  assert.equal(c?.id, "a");
  assert.equal(c?.label, "a");
});

test("parseClaims：不是数组或为空", () => {
  assert.throws(() => parseClaims({}), /非空数组/);
  assert.throws(() => parseClaims([]), /非空数组/);
});

test("parseClaims：路径不能写出仓库", () => {
  assert.throws(() => parseClaims([{ ...ok, file: "../README.md" }]), /仓库内的相对路径/);
  assert.throws(() => parseClaims([{ ...ok, fact: { type: "line-count", file: "/etc/passwd" } }]), /仓库内的相对路径/);
});

test("parseClaims：缺字段时指出是哪一条哪个字段", () => {
  assert.throws(() => parseClaims([{ ...ok, id: undefined }]), /claims\[0\].*id/);
  assert.throws(() => parseClaims([{ ...ok, file: "" }]), /file/);
  assert.throws(() => parseClaims([{ ...ok, fact: undefined }]), /fact/);
});

test("parseClaims：id 重复", () => {
  assert.throws(() => parseClaims([ok, ok]), /重复/);
});

test("parseClaims：locator 必须是合法正则且带捕获组", () => {
  assert.throws(() => parseClaims([{ ...ok, locator: "(" }]), /不是合法正则/);
  assert.throws(() => parseClaims([{ ...ok, locator: "\\d+ 个" }]), /捕获组/);
});

test("loadClaims：文件不存在时说明去哪里创建", () => {
  assert.throws(() => loadClaims(path.join(SKILL_ROOT, "不存在", "claims.json")), /找不到说法定义文件/);
});

test("impact：缺省为 normal，合法值原样通过，非法值指出哪一条", () => {
  assert.equal(parseClaims([ok])[0]?.impact, "normal");
  assert.equal(parseClaims([{ ...ok, impact: "high" }])[0]?.impact, "high");
  assert.equal(parseClaims([{ ...ok, impact: "low" }])[0]?.impact, "low");
  assert.throws(() => parseClaims([{ ...ok, impact: "critical" }]), /claims\[0\].*impact/);
  assert.throws(() => parseClaims([{ ...ok, impact: 3 }]), /impact/);
});

test("compare：缺省 eq；合法值通过；非法值、引用型事实上写 compare 都报错", () => {
  assert.equal(parseClaims([ok])[0]!.compare, "eq");
  for (const compare of ["eq", "gte", "lte", "approx"]) assert.equal(parseClaims([{ ...ok, compare }])[0]!.compare, compare);
  assert.throws(() => parseClaims([{ ...ok, compare: "gt" }]), /compare 只能是/);
  assert.throws(() => parseClaims([{ ...ok, compare: "gte", fact: { type: "path-exists" } }]), /compare 只用于数值型/);
});

test("tolerance：只在 approx 下有效，必须在 0 到 1 之间，缺省 0.05", () => {
  assert.equal(parseClaims([{ ...ok, compare: "approx" }])[0]!.tolerance, 0.05);
  assert.equal(parseClaims([{ ...ok, compare: "approx", tolerance: 0.2 }])[0]!.tolerance, 0.2);
  assert.throws(() => parseClaims([{ ...ok, tolerance: 0.2 }]), /只在 compare/);
  assert.throws(() => parseClaims([{ ...ok, compare: "approx", tolerance: 5 }]), /0 到 1/);
  assert.throws(() => parseClaims([{ ...ok, compare: "approx", tolerance: "10%" }]), /0 到 1/);
});