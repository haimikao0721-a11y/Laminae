/**
 * laminae —— 一次 git 调用拿到整条主线的变更，内存里滚动重建每个 commit 的文件树
 *
 * 原来每个 commit 都起一次 `git ls-tree -r`。Windows 上一次进程启动就要 29 ms，
 * 加上 ls-tree 本身 39 ms —— 6513 个 commit 就是 254 秒，占整条流水线的两成还多。
 *
 * profile 里 spawnSync 占 20.8%，和这个完全对得上。
 *
 * 现在改成：一次 `git log --first-parent --raw` 把全部变更读进来（几百 KB），
 * 然后从第一个 commit 的完整树出发，按顺序把每次变更套上去。
 *
 *   git ls-tree -r <第一个 commit>      1 次
 *   git log --first-parent --raw        1 次
 *   ----------------------------------------
 *   合计 2 次，无论历史多长
 *
 * 正确性要点：
 *   - `--first-parent` 让每个 commit 的 diff 是相对它的第一个父，和主线的定义一致
 *   - `--no-renames` 让改名显示成一删一增，不用处理相似度
 *   - 删除的条目 oid 记 null，套用时就把它从表里去掉
 */
import { git } from "../core/gitutil.ts";

interface Delta {
  path: string;
  /** 这个 commit 之后该路径的 blob 号；null 表示这个 commit 把它删了 */
  oid: string | null;
}

export class TreeWalker {
  /** 主线上的 commit，从最早到最晚 */
  private order: string[] = [];
  private deltas = new Map<string, Delta[]>();
  /** 现在表里反映的是第几个 commit 的状态 */
  private at = -1;
  private current = new Map<string, string>();
  private primed = false;
  private bySha = new Map<string, number>();

  /**
   * 一次读完主线。
   *
   * 注意不能拿「第一个被请求的 commit」当起点 —— 调用方按时间顺序问，第一次问的
   * 是**最早**那个，而 `git log <最早那个>` 只能返回它自己一条。
   * 起点必须是仓库尖端，这样 --reverse 之后才覆盖整条主线。
   */
  private prime(): void {
    // 第一个 commit 的完整树，只此一次 ls-tree。它的 sha 解析完 log 才知道。
    const initial = new Map<string, string>();
    // 整条主线的变更，一次读完
    const raw = git([
      "log",
      "--first-parent",
      "--reverse",
      "--no-renames",
      "--no-abbrev",
      "--format=C%x1f%H",
      "--raw",
      // 固定用 HEAD：调用方第一次问的是最早那个 commit，拿它当起点只能读到一条
      "HEAD",
    ]) ?? "";

    let cur: string | null = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("C\u001f")) {
        cur = line.slice(2).trim();
        if (!this.bySha.has(cur)) {
          this.bySha.set(cur, this.order.length);
          this.order.push(cur);
          this.deltas.set(cur, []);
        }
        continue;
      }
      if (!line.startsWith(":") || cur === null) continue;
      // :100644 100644 <old> <new> <status>\t<path>
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const cols = line.slice(0, tab).split(/\s+/);
      const newOid = cols[3] ?? "";
      const status = cols[4] ?? "";
      const path = line.slice(tab + 1);
      // D 是删除；其余（A/M/T）都给出新 blob
      this.deltas.get(cur)!.push({ path, oid: status.startsWith("D") ? null : newOid });
    }

    if (this.order.length === 0) throw new Error("读不到主线上的提交");
    const first = this.order[0]!;
    for (const line of (git(["ls-tree", "-r", first]) ?? "").split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const oid = line.slice(0, tab).split(" ")[2] ?? "";
      if (oid) initial.set(line.slice(tab + 1), oid);
    }
    this.base = initial;
    this.primed = true;
  }

  private base = new Map<string, string>();

  /** 取某个 commit 上的完整文件表（路径 → blob 号） */
  filesAt(sha: string): Map<string, string> {
    if (!this.primed) this.prime();
    const target = this.bySha.get(sha);
    if (target === undefined) return new Map(this.current);

    if (this.at < 0) {
      this.current = new Map(this.base);
      this.at = 0;
    }
    // 只能往前走。调用方按时间顺序问，这里不做回退重建
    while (this.at < target) {
      this.at++;
      const ds = this.deltas.get(this.order[this.at]!) ?? [];
      for (const d of ds) {
        if (d.oid === null) this.current.delete(d.path);
        else this.current.set(d.path, d.oid);
      }
    }
    return new Map(this.current);
  }
}
