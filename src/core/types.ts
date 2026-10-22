/**
 * laminae —— 共享类型
 *
 * 状态编码是全局约定，任何地方都不许用别的编码：
 *   0 = 真
 *   1 = 假
 *   2 = 还不存在（该 commit 上文档里还没有这条说法）
 *   3 = 测不出来（文档里有这条说法，但该 commit 上测不到对应的事实）
 *
 * 「还不存在」必须与「假」分开。一条说法在被写下的那个 commit 之前不是假，
 * 是还没有；混成假会让整张图左边全红。
 *
 * 「测不出来」必须与「还不存在」分开。说法明明在文档里，只是事实读不到
 * （例如被测文件在那个 commit 上缺失或损坏）；混成「还不存在」会让说法在图上凭空消失，
 * 也会让「说法被删掉」的结局无法与之区分。
 */
import type { Compare } from "../measure/compare.ts";
import type { FactSpec } from "../measure/facts.ts";
import type { LayerReport } from "../layers/layers-core.ts";

export type { LayerReport };
import type { Closure } from "../judge/survival.ts";

/** 真假状态 */
export const TRUE = 0;
export const FALSE = 1;
export const ABSENT = 2;
export const UNMEASURED = 3;
export type State = typeof TRUE | typeof FALSE | typeof ABSENT | typeof UNMEASURED;

/** 一个假段是怎么收场的 */
export type Outcome =
  /** 到 HEAD 仍为假，且现实一直没动 */
  | "hanging-reality-still"
  /** 到 HEAD 仍为假，但现实已经动过 */
  | "hanging-reality-moved"
  /** 现实追上了说法（说法是对的，世界错了） */
  | "reality-caught-up"
  /** 文档追上了现实（现实先动，文档后补） */
  | "doc-caught-up"
  /** 文档被改正（现实没动，文档本来就写错） */
  | "doc-corrected"
  /** 说法被删掉或改模糊（可能是在掩盖） */
  | "doc-removed"
  /** 假段之后事实测不出来，无法判定怎么收场 */
  | "unmeasurable"
  /** 两边都变了，无法判定 */
  | "both-changed"
  /** 无故翻转，异常，应排查 */
  | "anomaly";

/** 提交元信息 */
export interface Commit {
  i: number;
  /** 完整 SHA，用来拼 GitHub 链接 */
  sha: string;
  short: string;
  date: string;
  subject: string;
  /** 相对首个 commit 的小时数 */
  hours: number;
}

/** 使用者标注的说法重要程度。只用于排序与筛选，不参与任何计算 */
export const IMPACTS = ["high", "normal", "low"] as const;
export type Impact = (typeof IMPACTS)[number];

/** claims.json 里使用者写的一条说法：impact、compare、tolerance 可省略 */
export type ClaimInput = Omit<ClaimDef, "impact" | "compare" | "tolerance"> & { impact?: Impact; compare?: Compare; tolerance?: number };

/** 一条说法的定义，读取校验后的规范形式（目标仓库的 .laminae/claims.json） */
export interface ClaimDef {
  /** 重要程度，缺省 normal：读错了会不会让人做错事 */
  impact: Impact;
  /** 文档写的数和事实怎么比，缺省 eq（严格相等），见 compare.ts。引用型事实只能是 eq */
  compare: Compare;
  /** compare 为 approx 时允许的相对误差，其余情况不用 */
  tolerance: number;
  id: string;
  /** 文档里的定位正则，第 1 个捕获组必须是断言的那个数 */
  locator: string;
  /** 被测的事实，声明式，见 facts.ts */
  fact: FactSpec;
  /** 显示用的名字 */
  label: string;
  /** 说法所在文件 */
  file: string;
}

/** 一个 commit 上的测量结果 */
export interface MeasuredCommit {
  sha: string;
  short: string;
  date: string;
  subject: string;
  /** 该 commit 上被 git 跟踪的文件数 */
  tracked: number;
  /** 说法 id → 该 commit 上测到的事实；读不到为 null */
  values: Record<string, number | null>;
}

/** 一次假段 */
export interface Run {
  from: number;
  to: number;
  /** 长度，单位 commit */
  len: number;
  hoursFrom: number;
  hoursTo: number;
  /** 长度，单位小时 */
  hours: number;
  outcome: Outcome;
  /** 是否右删失（到 HEAD 仍为假，或之后事实测不出来） */
  censored: boolean;
  /** 写下即假：这一段从这条说法第一次出现就是假的，之前从未真过 */
  bornFalse: boolean;
  /** 假段期间现实有没有动过 */
  realityMoved: boolean;
  claimedAtStart: number | null;
  actualAtStart: number | null;
  actualAtEnd: number | null;
  claimedAfter: number | null;
}

/** 一段措辞未变的 commit 区间。同一行原文只存一次，不逐 commit 重复 */
export interface VerbatimRun {
  from: number;
  to: number;
  /** 该区间内文档那一行的原文；null 表示这一区间里还没有这条说法 */
  text: string | null;
}

/** 一条说法的完整时间线 */
export interface ClaimTimeline {
  id: string;
  /** 使用者标注的重要程度，只用于排序与筛选 */
  impact: Impact;
  /** 文档写的数和事实的比较方式 */
  compare: Compare;
  tolerance: number;
  /** 严格相等的数值说法，文档措辞像下限 / 近似时，命中的那一小段原文（提醒用，不影响判定） */
  inexact?: string | null;
  label: string;
  file: string;
  asserts: string;
  locator: string;
  /** HEAD 上的逐字原文 */
  verbatim: string;
  /** HEAD 上原文所在行号，0 表示没找到 */
  line: number;
  /**
   * 这条说法的 locator 在整段历史里一次都没匹配到。
   *
   * 两种可能：文档确实没写过这句话，或者 locator 写错了。工具分不清，所以不替使用者下结论，
   * 只把这件事标出来 —— 让人去跑 lookup 看一眼。混进「尚未写入文档」会误导：
   * 那读起来像「文档没写」，实际可能是「正则写错」。 */
  ruleMiss: boolean;
  /**
   * 引用型说法判假，但把捕获到的文本去掉首尾标点就对得上了。多半是捕获组多带了字符，
   * 比如 locator 里的反引号被写进了括号内。这里只给提示，不改判定。 */
  captureHint: string | null;
  /** 文档措辞随时间的变化，行程编码 */
  verbatimRuns: VerbatimRun[];
  /** 每个 commit 一格 */
  states: State[];
  /**
   * 说法的种类。
   * number：文档写的是个数。
   * exists：文档写的是对仓库里某物的引用，事实是它存不存在。
   * holds：测试或不变量，事实是跑出来过不过。
   * stable：输出差分，事实是相对这句写下时变没变。
   */
  kind: "number" | "exists" | "holds" | "stable";
  /**
   * 每个 commit 上文档写的数。
   * exists / holds / stable 的这一列是文本或文件正文的编号，只用来判断声称有没有改过，
   * 显示用 claimedText。
   */
  claimed: (number | null)[];
  /** exists / holds / stable：每个 commit 上捕获到的文本；number 类为空数组 */
  claimedText: (string | null)[];
  /** 每个 commit 上实际测到的数 */
  actual: (number | null)[];
  runs: Run[];
  /** 写下即假（从未真过） */
  bornFalse: boolean;
  /** 到 HEAD 的状态 */
  atHead: State;
  headClaimed: number | null;
  headActual: number | null;
  totalFalse: number;
  /** 事实读的文件（证据所在）。图上用它把说法连到节点 */
  evidence: string[];
}

/** 汇总 */
export interface Summary {
  claimCount: number;
  commitCount: number;
  spanHours: number;
  everFalse: number;
  falseAtHead: number;
  bornFalse: number;
  drifted: number;
  runCount: number;
  censored: number;
  /** 先真后假的假段（不含写下即假）的 Kaplan-Meier 估计，见 survival.ts */
  survival: SurvivalSummary;
  outcomes: Partial<Record<Outcome, number>>;
  /** 收场方式汇总：改文档、删说法、改现实各占多少 */
  closure: Closure;
}

export interface SurvivalSummary {
  /** 样本数：先真后假的假段 */
  n: number;
  /** 其中真的结束了的段数 */
  events: number;
  /** 其中右删失的段数（仍挂着，或之后事实测不出来） */
  censored: number;
  /** 中位 hiatus（commit）；生存曲线没降到 50% 时为 null，表示无法估计 */
  medianCommits: number | null;
  /** 中位 hiatus（小时）；同上 */
  medianHours: number | null;
}

/* ── 引用关系图 ── */

/** commit 下标上的闭区间 [from, to] */
export type Interval = readonly [number, number];

/** 模块之间的引用关系随时间的变化，行程编码。见 graph-core.ts */
export interface GraphData {
  /** file：一个文件一个节点；dir：文件太多，已按目录合并 */
  level: "file" | "dir";
  /** 合并的目录深度；level 为 file 时为 null */
  depth: number | null;
  /** test：测试文件（合并成目录后，目录下全是测试才算）。图上默认折掉 */
  nodes: { id: string; alive: Interval[]; test: boolean }[];
  /** s 引用 t，下标指向 nodes */
  edges: { s: number; t: number; alive: Interval[] }[];
  /** 历史上出现过的代码文件总数（合并前） */
  fileCount: number;
}

/* ── 想法与边界 ── */

/** 想法在某个 commit 上的状态：0 证据已满足，1 证据未满足，3 测不出来 */
export type IdeaState = 0 | 1 | 3;

/** 一条想法或边界，及它的证据在每个 commit 上是否满足 */
export interface IdeaTimeline {
  id: string;
  text: string;
  /** 边界：刻意不做的事。证据满足 = 守住，不满足 = 越界 */
  boundary: boolean;
  /** present：证据指向的东西应该存在；absent：应该不存在 */
  expect: "present" | "absent";
  target: string;
  /** 证据读的文件（text-in-file、json-has-key 的 file）；调用关系图靠它把想法挂到对应的模块上 */
  evidence: string[];
  /** 引用边界才有：from 下的文件引用 to 下的文件。图上靠它把这条想法挂到两端的模块上、标出对应的线 */
  edge?: { from: string; to: string };
  /** 引用边界在 HEAD 上符合的引用，最多 30 条。边界（absent）下这就是越界的那几条 */
  hits?: [string, string][];
  /** HEAD 上符合的引用一共几条 */
  hitsTotal?: number;
  /** 引用边界在 HEAD 上判不了的原因（别名路径解析不了、语言不支持），判得了为 null */
  unsure?: string | null;
  /** 证据的一句话描述 */
  check: string;
  /** 想法的出处，如 ROADMAP.md:12，选填 */
  source: string;
  states: IdeaState[];
  atHead: IdeaState;
  /** 第一次满足的 commit 下标，没有为 -1 */
  firstMet: number;
  /** 满足之后又退回不满足的次数 */
  regressions: number;
}

/** 从仓库里找出来的、尚未确认的想法线索。工具不替人判定它们 */
export interface Candidate {
  file: string;
  line: number;
  text: string;
  /** 清单项是否已勾选；TODO 没有此字段 */
  done?: boolean;
}

export interface Candidates {
  checklist: { open: number; done: number; items: Candidate[] };
  todos: { total: number; items: Candidate[] };
  /** 沿历史均匀抽样的数量趋势，at 是 commit 下标 */
  trend: { at: number[]; todo: number[]; open: number[]; done: number[] };
}

/** 内联进 HTML 的完整载荷 */
/** 说法本身写不出来的地方。不改判定，只是让作者知道这条测不了 */
export interface ClaimWarning {
  id: string;
  label: string;
  level: "error" | "warn";
  code: string;
  message: string;
}

export interface Payload {
  title: string;
  subtitle: string;
  repo: string;
  /** 仓库主页，用来拼「去核对」的链接 */
  repoUrl: string;
  generatedAt: string;
  commits: Commit[];
  claims: ClaimTimeline[];
  summary: Summary;
  /** 说法体检的结果。有的话报告顶部会提示 */
  claimWarnings?: ClaimWarning[];
  /** 模块引用关系；没有可解析的 JS/TS/Python 代码时没有 */
  graph?: GraphData;
  /** 想法与边界；没有 .laminae/ideas.json 时没有 */
  ideas?: IdeaTimeline[];
  /** 想法线索（路线图清单、TODO） */
  candidates?: Candidates;
  /** 层与层的对账：假实现、被盖住、有代码但未证实。没有跑过引用扫描时没有 */
  layers?: LayerReport;
}

/** 结局的中文说明，界面与报告共用，避免两处写不一致 */
export const OUTCOME_TEXT: Record<Outcome, string> = {
  "hanging-reality-still": "仍挂着，现实一直没动",
  "hanging-reality-moved": "仍挂着，现实已经动过",
  "reality-caught-up": "现实追上了说法",
  "doc-caught-up": "文档追上了现实",
  "doc-corrected": "文档被改正",
  "doc-removed": "说法被删掉或改模糊",
  "unmeasurable": "事实测不出来，无法判定",
  "both-changed": "两边都变了，无法判定",
  "anomaly": "无故翻转，异常",
};
