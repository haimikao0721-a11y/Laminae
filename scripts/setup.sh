#!/usr/bin/env bash
# laminae 环境检查（macOS / Linux）
#
#   bash scripts/setup.sh              只检查，缺什么就打印安装命令，不改系统
#   bash scripts/setup.sh --install    缺 git 或 node 时，用系统包管理器安装（每一项先确认）
#   bash scripts/setup.sh --install --yes  同上，不再逐项确认
#
# 检查项：git 是否存在；node 是否存在，并且能直接运行 .ts 文件。
# 后一项是实际运行一小段 TypeScript 得到的结论，不是凭版本号猜。
# 退出码：0 环境可用，1 有缺项。

INSTALL=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --yes) YES=1 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

# 用一段最小的 TypeScript 验证 node 能直接运行 .ts（不带任何参数）
node_runs_ts() {
  local probe out
  probe="$(mktemp "${TMPDIR:-/tmp}/laminae-probe-XXXXXX")" || return 1
  mv "$probe" "$probe.ts"; probe="$probe.ts"
  printf 'const n: number = 1; console.log("laminae-ok" + n);\n' > "$probe"
  out="$(node "$probe" 2>/dev/null)"
  local code=$?
  rm -f "$probe"
  [ "$code" -eq 0 ] && [ "$out" = "laminae-ok1" ]
}

HAS_GIT=0; HAS_NODE=0; HAS_TS=0
check() {
  HAS_GIT=0; HAS_NODE=0; HAS_TS=0
  have git && HAS_GIT=1
  if have node; then
    HAS_NODE=1
    node_runs_ts && HAS_TS=1
  fi
}

show() {
  if [ "$HAS_GIT" -eq 1 ]; then echo "[ok]   git   $(git --version)"; else echo "[缺]   git   未找到"; fi
  if [ "$HAS_NODE" -eq 0 ]; then
    echo "[缺]   node  未找到"
  elif [ "$HAS_TS" -eq 1 ]; then
    echo "[ok]   node  $(node --version)，可以直接运行 .ts"
  else
    echo "[不行] node  $(node --version)，不能直接运行 .ts（通常是版本太旧）"
  fi
}

all_ok() { [ "$HAS_GIT" -eq 1 ] && [ "$HAS_NODE" -eq 1 ] && [ "$HAS_TS" -eq 1 ]; }

# 识别包管理器，输出安装命令（git 与 node 各一条）。认不出来返回空
pkg_cmd() {
  local what="$1" sudo=""
  [ "$(id -u)" -ne 0 ] && have sudo && sudo="sudo "
  if [ "$(uname -s)" = "Darwin" ]; then
    have brew && echo "brew install $what"
  elif have apt-get; then echo "${sudo}apt-get install -y $what"
  elif have dnf; then echo "${sudo}dnf install -y $what"
  elif have pacman; then echo "${sudo}pacman -S --noconfirm $what"
  elif have zypper; then echo "${sudo}zypper install -y $what"
  fi
}

install_one() {
  local what="$1" pkg="$2" cmd
  cmd="$(pkg_cmd "$pkg")"
  if [ -z "$cmd" ]; then
    echo "认不出系统的包管理器，无法自动安装 $what。请手动安装。"
    return
  fi
  if [ "$YES" -eq 0 ]; then
    printf '将执行：%s\n继续？[y/N] ' "$cmd"
    read -r answer
    case "$answer" in y|Y|yes|YES) ;; *) echo "已跳过 $what"; return ;; esac
  fi
  eval "$cmd"
}

check
show

if all_ok; then
  echo
  echo "环境可用。"
  exit 0
fi

if [ "$INSTALL" -eq 1 ]; then
  [ "$HAS_GIT" -eq 0 ] && install_one "git" "git"
  if [ "$HAS_NODE" -eq 0 ] || [ "$HAS_TS" -eq 0 ]; then install_one "Node.js" "nodejs"; fi
  echo
  echo "重新检查："
  check
  show
  if all_ok; then
    echo
    echo "环境可用。"
    exit 0
  fi
  echo
  echo "仍有缺项。包管理器里的 Node 版本可能偏旧，可改用 https://nodejs.org 的安装包或 nvm。"
  exit 1
fi

echo
echo "缺项的安装方式："
if [ "$HAS_GIT" -eq 0 ]; then
  cmd="$(pkg_cmd git)"
  echo "  git   ${cmd:-见 https://git-scm.com/downloads}"
fi
if [ "$HAS_NODE" -eq 0 ] || [ "$HAS_TS" -eq 0 ]; then
  cmd="$(pkg_cmd nodejs)"
  echo "  node  ${cmd:-见 https://nodejs.org}"
fi
echo "也可以让本脚本代装：bash scripts/setup.sh --install"
exit 1
