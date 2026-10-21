import { test } from "node:test";
import assert from "node:assert/strict";
import { alignToBaseline, fingerprint, interpretObserved, nextObservation, watchKey } from "../src/observe.ts";

test("interpretObserved：退出码 0 是通过，非 0 是失败，超时是测不出来", () => {
  assert.equal(interpretObserved("test-passes", { failed: false, code: 0, stdout: "" }), 1);
  assert.equal(interpretObserved("invariant-holds", { failed: false, code: 1, stdout: "" }), 0);
  assert.equal(interpretObserved("test-passes", { failed: true, code: null, stdout: "" }), null);
});

test("interpretObserved：输出指纹只认内容，崩溃和成功不是同一份", () => {
  const a = interpretObserved("output-unchanged", { failed: false, code: 0, stdout: "12\n" });
  const b = interpretObserved("output-unchanged", { failed: false, code: 0, stdout: "12\r\n" });
  const c = interpretObserved("output-unchanged", { failed: false, code: 0, stdout: "13\n" });
  const crashed = interpretObserved("output-unchanged", { failed: false, code: 1, stdout: "12\n" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, crashed);
  assert.equal(a, fingerprint("12"));
});

test("alignToBaseline：相对这句话第一次出现时的输出，句子变了基线重置", () => {
  assert.deepEqual(alignToBaseline(["v1", "v1", "v1"], [10, 10, 11]), [1, 1, 0]);
  assert.deepEqual(alignToBaseline(["v1", "v1", "v2"], [10, 11, 11]), [1, 0, 1]);
  assert.deepEqual(alignToBaseline([null, "v1"], [10, 10]), [null, 1]);
  assert.deepEqual(alignToBaseline(["v1", "v1"], [null, 10]), [null, 1]);
});

test("watchKey：内容没变键相同，变了就不同；一个文件都没匹配到是 null", () => {
  const files: Record<string, string> = { "fee.py": "a", "other.py": "z" };
  const read = (f: string) => files[f] ?? null;
  const paths = Object.keys(files);
  const first = watchKey(paths, read, ["fee.py"]);
  assert.equal(watchKey(paths, read, ["fee.py"]), first);
  files["fee.py"] = "b";
  assert.notEqual(watchKey(paths, read, ["fee.py"]), first);
  assert.equal(watchKey(paths, read, ["missing.py"]), null);
});

test("nextObservation：watch 没变不再跑", () => {
  const files: Record<string, string> = { "fee.py": "a" };
  let runs = 0;
  const once = (sha: string) =>
    nextObservation({
      fact: { type: "test-passes", command: "pytest", watch: ["fee.py"] },
      sha,
      paths: Object.keys(files),
      read: (f) => files[f] ?? null,
      cache: undefined,
      materialize: () => "/tmp",
      run: () => {
        runs++;
        return { failed: false, code: 0, stdout: "" };
      },
    });
  const first = once("aaa");
  assert.equal(runs, 1);
  assert.equal(first.value, 1);
  const second = nextObservation({
    fact: { type: "test-passes", command: "pytest", watch: ["fee.py"] },
    sha: "bbb",
    paths: Object.keys(files),
    read: (f) => files[f] ?? null,
    cache: first.cache,
    materialize: () => "/tmp",
    run: () => {
      runs++;
      return { failed: false, code: 1, stdout: "" };
    },
  });
  assert.equal(runs, 1, "文件没变，不该再跑");
  assert.equal(second.value, 1);
  assert.equal(second.ran, false);
});
