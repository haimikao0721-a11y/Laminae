import { test } from "node:test";
import assert from "node:assert/strict";
import { isCodeFile, parseFileImports, resolveJs, sfcScript } from "../src/layers/imports.ts";

// vue 上最后 4 条孤立全是同一个原因：引用它们的是 .vue 文件，
// 而 .vue 不在代码文件范围内，那条边根本不存在。
//
//   packages-private/sfc-playground/src/Header.vue
//   import { downloadProject } from './download/download'
//
// 现在单文件组件算代码文件，但**只解析 <script> 块** —— 模板是 HTML，
// 当 JS 解析会把属性里写的东西当成代码。

const SFC = [
  '<template>',
  '  <button @click="function (x) { return x }">按我</button>',
  '</template>',
  '',
  '<script setup lang="ts">',
  "import { computed } from 'vue'",
  "import { downloadProject } from './download/download'",
  "import Sun from './icons/Sun.vue'",
  '</script>',
].join("\n");

test("单文件组件：算代码文件，能被别的文件引用", () => {
  assert.equal(isCodeFile("src/Header.vue"), true);
  assert.equal(isCodeFile("src/Header.svelte"), true);
});

test("单文件组件：只取 <script> 块，模板不当代码", () => {
  const script = sfcScript(SFC);
  assert.equal(script.includes("@click"), false, "模板部分不该进来");
  assert.equal(script.includes("import"), true);
  // 模板里那个 function 表达式不该被当成函数
  assert.equal(script.includes("return x"), false);
});

test("单文件组件：<script> 里的相对引用能解析到 .ts 和 .vue", () => {
  const imports = parseFileImports("src/Header.vue", sfcScript(SFC));
  const files = new Set(["src/download/download.ts", "src/icons/Sun.vue"]);
  const resolved = imports
    .map((i) => resolveJs("src/Header.vue", i.spec, { files, read: () => null }))
    .filter((x) => x !== null);
  assert.deepEqual(resolved.sort(), ["src/download/download.ts", "src/icons/Sun.vue"]);
});

test("单文件组件：没有 <script> 块时返回空串，不退回把整个文件当 JS", () => {
  const noScript = '<template><div>只有模板</div></template>';
  assert.equal(sfcScript(noScript), "");
  // 空正文解不出引用；返回 null 还是空数组都算对，只要不是「有引用」
  const none = parseFileImports("src/X.vue", sfcScript(noScript));
  assert.equal((none ?? []).length, 0);
});

test("单文件组件：多个 script 块（普通 + setup）都要拼起来", () => {
  const two = [
    '<script lang="ts">',
    "export default { name: 'X' }",
    '</script>',
    '<script setup lang="ts">',
    "import y from './y'",
    '</script>',
  ].join("\n");
  const merged = sfcScript(two);
  assert.ok(merged.includes("export default"));
  assert.ok(merged.includes("import y"));
});
