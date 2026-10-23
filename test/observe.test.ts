import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { alignToBaseline, fingerprint, interpretObserved, nextObservation, runCommand, watchKey } from "../src/measure/observe.ts";

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

test("nextObservation：watch 没变不再跑", async () => {
  const files: Record<string, string> = { "fee.py": "a" };
  let runs = 0;
  const first = await nextObservation({
    fact: { type: "test-passes", command: "pytest", watch: ["fee.py"] },
    sha: "aaa",
    paths: Object.keys(files),
    read: (f) => files[f] ?? null,
    cache: undefined,
    materialize: () => "/tmp",
    run: async () => {
      runs++;
      return { failed: false, code: 0, stdout: "" };
    },
  });
  assert.equal(runs, 1);
  assert.equal(first.value, 1);
  const second = await nextObservation({
    fact: { type: "test-passes", command: "pytest", watch: ["fee.py"] },
    sha: "bbb",
    paths: Object.keys(files),
    read: (f) => files[f] ?? null,
    cache: first.cache,
    materialize: () => "/tmp",
    run: async () => {
      runs++;
      return { failed: false, code: 1, stdout: "" };
    },
  });
  assert.equal(runs, 1, "文件没变，不该再跑");
  assert.equal(second.value, 1);
  assert.equal(second.ran, false);
});

// 超时之后只杀 shell 是不够的：命令里起一个服务（npm test 常常会），
// shell 被杀了，那个服务还在跑、还占着端口，下一次跑同一份 claims 会撞上
// 自己上一次留下的东西 —— 表现出来是「测试偶尔失败」，看起来像项目的问题。
//
// 这条测试起一个会活 60 秒的子进程，让命令超时，然后确认那个子进程真的死了。
// 它同时是「为什么 runCommand 必须是异步」的证据：同步版本超时时**先杀 shell 才返回**，
// 等拿到 pid 时树根已经不在，taskkill 找不到它，孙进程就留下来了。
test("命令超时后，整棵子进程树都被杀掉", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "laminae-kill-"));
  const marker = path.join(dir, "child.pid");
  try {
    const where = marker.replace(/\\/g, "/");
    const script = `node -e "require('fs').writeFileSync('${where}', String(process.pid)); setTimeout(function(){}, 60000)"`;
    const out = await runCommand(script, dir, 1200);
    assert.equal(out.failed, true, "超时应当算失败");

    await new Promise((r) => setTimeout(r, 900));
    assert.equal(fs.existsSync(marker), true, "子进程应当先把 pid 写出来了");
    const pid = Number(fs.readFileSync(marker, "utf8").trim());
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `子进程 ${pid} 还活着 —— 超时没有清理干净`);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上偶尔删不掉，不影响这条测试的结论
    }
  }
});
