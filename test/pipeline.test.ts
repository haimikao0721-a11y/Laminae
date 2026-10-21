/**
 * 端到端：在合成的 git 仓库上跑 measure → analyze，检查 git 历史里的各种边界情况。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVELS_CLAIM, TestRepo, readme, runPipeline, sys } from "./helpers.ts";
import { ABSENT, FALSE, TRUE, UNMEASURED } from "../src/types.ts";

/** 建仓库、跑流程、清理；回调里负责造提交 */
function scenario(build: (r: TestRepo) => void, claims = [LEVELS_CLAIM]) {
  const repo = new TestRepo();
  try {
    build(repo);
    return { pipeline: runPipeline(repo, claims), repo };
  } finally {
    repo.dispose();
  }
}

test("线性历史：现实先变、文档后补，结局是 doc-caught-up", () => {
  const { pipeline } = scenario((r) => {
    r.commit({ "assets/data/systems.json": sys(3), "README.md": readme(3) });
    r.commit({ "assets/data/systems.json": sys(5) }); // 现实变了，文档还写 3
    r.commit({ "README.md": readme(5) }); // 文档补上
  });
  const [res] = pipeline.results;
  assert.deepEqual(res?.states, [TRUE, FALSE, TRUE]);
  assert.deepEqual(res?.outcomes, ["doc-caught-up"]);
});

test("说法被删掉：假段之后文档里找不到，结局是 doc-removed", () => {
  const { pipeline } = scenario((r) => {
    r.commit({ "assets/data/systems.json": sys(3), "README.md": readme(3) });
    r.commit({ "assets/data/systems.json": sys(4) });
    r.commit({ "README.md": readme(null) });
  });
  const [res] = pipeline.results;
  assert.deepEqual(res?.states, [TRUE, FALSE, ABSENT]);
  assert.deepEqual(res?.outcomes, ["doc-removed"]);
});

test("事实文件损坏：说法还在但测不出来，是 UNMEASURED，不是「还不存在」", () => {
  const { pipeline } = scenario((r) => {
    r.commit({ "assets/data/systems.json": sys(3), "README.md": readme(3) });
    r.commit({ "assets/data/systems.json": sys(4) });
    r.commit({ "assets/data/systems.json": "{ 这不是合法 JSON" });
  });
  const [res] = pipeline.results;
  assert.deepEqual(res?.states, [TRUE, FALSE, UNMEASURED]);
  assert.deepEqual(res?.outcomes, ["unmeasurable"]);
});

test("事实文件整个缺失：同样是 UNMEASURED", () => {
  const { pipeline } = scenario((r) => {
    r.commit({ "assets/data/systems.json": sys(3), "README.md": readme(3) });
    r.commit({ "assets/data/systems.json": null });
  });
  assert.deepEqual(pipeline.results[0]?.states, [TRUE, UNMEASURED]);
});

test("说法所在文件不止 README：每条说法读自己的文件（回归：此前除 README 外都被当成另一个文件）", () => {
  const { pipeline } = scenario(
    (r) => {
      r.commit({
        "assets/data/systems.json": sys(3),
        "README.md": readme(9), // README 写错
        "docs/guide.md": "指南：共 3 关。\n", // 指南写对
      });
    },
    [
      LEVELS_CLAIM,
      { ...LEVELS_CLAIM, id: "guide", file: "docs/guide.md", label: "指南关数" },
    ],
  );
  const byId = Object.fromEntries(pipeline.results.map((r) => [r.id, r.states]));
  assert.deepEqual(byId["levels"], [FALSE]);
  assert.deepEqual(byId["guide"], [TRUE]);
});

test("合并提交：只沿主线取序列，被合并分支上的提交不混进来", () => {
  const { pipeline, repo } = (() => {
    const r = new TestRepo();
    try {
      r.commit({ "assets/data/systems.json": sys(3), "README.md": readme(3) });
      r.git("switch", "-q", "-c", "side");
      r.commit({ "assets/data/systems.json": sys(4) }, "side：现实变了");
      r.commit({ "assets/data/systems.json": sys(5) }, "side：又变");
      r.git("switch", "-q", "main");
      r.commit({ "other.txt": "x" }, "main：无关改动");
      r.merge("side");
      const firstParent = Number(r.git("rev-list", "--first-parent", "--count", "HEAD").trim());
      const all = Number(r.git("rev-list", "--count", "HEAD").trim());
      return { pipeline: runPipeline(r), repo: { firstParent, all } };
    } finally {
      r.dispose();
    }
  })();

  assert.equal(repo.all, 5, "合并后一共 5 个提交");
  assert.equal(repo.firstParent, 3, "主线只有 3 个");
  assert.equal(pipeline.commitCount, 3, "序列应只含主线的 3 个提交");
  // 主线：初始(真) → 无关改动(真) → 合并提交(现实变成 5，文档仍写 3 → 假)
  assert.deepEqual(pipeline.results[0]?.states, [TRUE, TRUE, FALSE]);
});

test("文件改名：目前会被当作说法消失（已知局限，改名追踪尚未实现）", () => {
  const { pipeline } = scenario((r) => {
    r.commit({ "assets/data/systems.json": sys(3), "README.md": readme(3) });
    r.git("mv", "README.md", "README-zh.md");
    r.commit({}, "README 改名");
  });
  assert.deepEqual(pipeline.results[0]?.states, [TRUE, ABSENT]);
});
