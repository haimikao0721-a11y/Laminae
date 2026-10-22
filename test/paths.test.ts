import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SKILL_ROOT } from "../src/core/paths.ts";

// SKILL_ROOT 靠数「..」的层数算出来。文件一搬家就错，而且**错了不报错** ——
// 所有指向它的东西（SKILL.md、dist、scripts）会静默指到别处，直到某一步读不到文件才炸。
//
// 从 src/ 搬到 src/core/ 那次就差了正好一级。这一条把锚点钉死。
test("SKILL_ROOT 指向仓库根，不是 src 也不是 src/core", () => {
  assert.ok(fs.existsSync(path.join(SKILL_ROOT, "SKILL.md")), "仓库根应该有 SKILL.md");
  assert.ok(fs.existsSync(path.join(SKILL_ROOT, "package.json")), "仓库根应该有 package.json");
  assert.ok(fs.existsSync(path.join(SKILL_ROOT, "src")), "仓库根应该有 src/");
  assert.ok(fs.statSync(path.join(SKILL_ROOT, "src")).isDirectory(), "src 应该是目录");
  // 反证：仓库根下面不该直接有 types.ts 这种东西（那是 src/core/ 里的）
  assert.equal(fs.existsSync(path.join(SKILL_ROOT, "types.ts")), false, "SKILL_ROOT 退过头了");
});

// 步骤脚本的路径是**仓库相对路径**，不是相对 src/ 的裸文件名。
// 裸名加隐式前缀的写法会让搬文件变成猜谜 —— 改的人记不住前缀是什么，
// 而 tsc 查不出这种字符串错，只有跑测试才会炸。
test("run.ts 的步骤路径都指向真实存在的文件", async () => {
  const src = fs.readFileSync(path.join(SKILL_ROOT, "scripts", "run.ts"), "utf8");
  const files = [...src.matchAll(/file:\s*"([^"]+\.ts)"/g)].map((m) => m[1]!);
  assert.ok(files.length >= 6, `应该找到至少 6 个步骤，实际 ${files.length}`);
  for (const f of files) {
    assert.ok(f.startsWith("src/"), `步骤路径应该是仓库相对路径：${f}`);
    assert.ok(fs.existsSync(path.join(SKILL_ROOT, f)), `步骤文件不存在：${f}`);
  }
});
