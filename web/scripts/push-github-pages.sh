#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_URL="${WEB_GITHUB_PAGES_REPO_URL:-https://github.com/D4U-DoforYou/NFC-card-reader.git}"
BRANCH="${WEB_GITHUB_PAGES_BRANCH:-web_github_pages}"

command -v git >/dev/null || { echo "需要安装 Git。" >&2; exit 1; }
command -v npm >/dev/null || { echo "需要安装 Node.js 和 npm。" >&2; exit 1; }

cd "$WEB_DIR"
echo "==> 安装锁定的 Web 依赖"
npm ci

echo "==> 构建 GitHub Pages 静态站点"
GITHUB_PAGES=true npm run build
DIST_DIR="$WEB_DIR/dist"
if [[ ! -f "$DIST_DIR/index.html" ]]; then
  echo "构建没有生成 $DIST_DIR/index.html。" >&2
  exit 1
fi
touch "$DIST_DIR/.nojekyll"

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/d4u-pages.XXXXXX")"
cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT
DEPLOY_DIR="$TEMP_DIR/site"

echo "==> 获取 $BRANCH 部署分支"
git clone --quiet --single-branch --branch "$BRANCH" "$REPO_URL" "$DEPLOY_DIR"

# Keep branch metadata and any custom-domain CNAME; replace prior site output.
find "$DEPLOY_DIR" -mindepth 1 -maxdepth 1 \
  ! -name .git ! -name README.md ! -name LICENSE ! -name CNAME \
  -exec rm -rf -- {} +
cp -R "$DIST_DIR/." "$DEPLOY_DIR/"

git -C "$DEPLOY_DIR" add --all
if git -C "$DEPLOY_DIR" diff --cached --quiet; then
  echo "==> 静态站点没有变化，无需推送。"
  exit 0
fi

git -C "$DEPLOY_DIR" commit -m "deploy: publish web site"
echo "==> 推送到 $BRANCH"
git -C "$DEPLOY_DIR" push origin "HEAD:refs/heads/$BRANCH"
echo "==> 发布完成：$REPO_URL/tree/$BRANCH"
