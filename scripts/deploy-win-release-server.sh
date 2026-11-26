#!/usr/bin/env bash
# ==============================================================================
# 讲界视频工坊 Windows 桌面端 + 官网下载区 生产服务器一键上线脚本
# 适用主机：部署 https://jiangjie.gingers.cloud/ 的 Linux Nginx 服务器
#
# 用法示例（在服务器上以 root 或具备 sudo 权限的用户执行）：
#   sudo bash deploy-win-release-server.sh v0.2.1-win-native.1
#
# 可选环境变量：
#   GITHUB_REPO=akechi0819-lgtm/knowledge-video-requirements
#   GIT_REF=feat/win-native-installer      # 拉取官网 index.html / downloads.js 的分支或 tag
#   SITE_ROOT=/opt/jiangjie-preview/site   # 官网静态文件根目录
#   FORCE_CHANNEL=                         # 可选：强行覆盖通道（默认按 release-manifest.json 自动识别）
#   SKIP_SITE_HTML=0                       # 设为 1 时仅同步 /downloads/ 产物，不覆盖 index.html
# ==============================================================================
set -euo pipefail

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "用法: sudo bash $0 <GitHub Release Tag，例如 v0.2.1-win-native.1>" >&2
  exit 1
fi

GITHUB_REPO="${GITHUB_REPO:-akechi0819-lgtm/knowledge-video-requirements}"
GIT_REF="${GIT_REF:-$TAG}"
SITE_ROOT="${SITE_ROOT:-/opt/jiangjie-preview/site}"
SKIP_SITE_HTML="${SKIP_SITE_HTML:-0}"
FORCE_CHANNEL="${FORCE_CHANNEL:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR="/tmp/jiangjie-win-deploy-${STAMP}"
BAK_DIR="/tmp/jiangjie-win-backup-${STAMP}"

mkdir -p "$WORK_DIR/assets" "$WORK_DIR/components" "$BAK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "======================================================================"
echo " 讲界视频工坊 Windows 发布上线"
echo "   Repo      : ${GITHUB_REPO}"
echo "   Tag       : ${TAG}"
echo "   Site Root : ${SITE_ROOT}"
echo "   Backup    : ${BAK_DIR}"
echo "======================================================================"

for cmd in curl sha256sum python3 nginx; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[ERROR] 缺少必需命令: $cmd" >&2
    exit 1
  fi
done

# 1. 查询 GitHub Release 元数据并下载全部已验证产物
echo "[1/6] 从 GitHub Release (${TAG}) 拉取已通过纯净机验收的安装包与清单..."
RELEASE_API="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${TAG}"
AUTH_ARGS=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

curl -fsSL "${AUTH_ARGS[@]}" -H "Accept: application/vnd.github+json" "$RELEASE_API" -o "$WORK_DIR/release.json"

python3 - "$WORK_DIR/release.json" "$WORK_DIR/asset-urls.tsv" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
assets = doc.get("assets") or []
if not assets:
    raise SystemExit("Release 下没有找到任何附件，请确认 GitHub Actions publish-release 已成功完成。")
with open(sys.argv[2], "w", encoding="utf-8") as f:
    for a in assets:
        f.write(f"{a['name']}\t{a['browser_download_url']}\n")
print(f"Found {len(assets)} release assets.")
PY

while IFS=$'\t' read -r name url; do
  echo "  -> 下载 ${name}"
  if [[ "$name" == component-*.tar.gz ]]; then
    curl -fL --retry 3 --retry-delay 2 "${AUTH_ARGS[@]}" "$url" -o "$WORK_DIR/assets/components/${name}" --create-dirs
  else
    curl -fL --retry 3 --retry-delay 2 "${AUTH_ARGS[@]}" "$url" -o "$WORK_DIR/assets/${name}"
  fi
done < "$WORK_DIR/asset-urls.tsv"

# 2. 服务端二次 SHA-256 完整性校验（防传输损坏）
echo "[2/6] 校验 SHA256SUMS.txt 完整性..."
(
  cd "$WORK_DIR/assets"
  sha256sum -c SHA256SUMS.txt
)

# 3. 解析版本号、序列号与通道
read -r CHANNEL SEQ VERSION < <(python3 - "$WORK_DIR/assets/releases.win.json" "$FORCE_CHANNEL" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
channel = sys.argv[2] or doc["channel"]
print(channel, doc["releaseSequence"], doc["version"])
PY
)
YAML_FILE="latest.yml"
if [ "$CHANNEL" = "beta" ]; then YAML_FILE="beta.yml"; fi
echo "  -> 识别发布元数据: version=${VERSION}, channel=${CHANNEL}, releaseSequence=${SEQ}"

# 4. 备份现有站点关键文件与 Nginx 配置
echo "[3/6] 备份当前站点与 Nginx 配置至 ${BAK_DIR}..."
[ -f "${SITE_ROOT}/index.html" ] && cp -a "${SITE_ROOT}/index.html" "${BAK_DIR}/index.html"
[ -f "${SITE_ROOT}/downloads.js" ] && cp -a "${SITE_ROOT}/downloads.js" "${BAK_DIR}/downloads.js"
[ -f "${SITE_ROOT}/downloads/release-manifest.json" ] && cp -a "${SITE_ROOT}/downloads/release-manifest.json" "${BAK_DIR}/release-manifest.json"
NGINX_CONF="$(grep -rl "jiangjie.gingers.cloud" /etc/nginx/ 2>/dev/null | head -n 1 || true)"
if [ -n "$NGINX_CONF" ] && [ -f "$NGINX_CONF" ]; then
  cp -a "$NGINX_CONF" "${BAK_DIR}/nginx.conf"
  echo "  -> 已备份 Nginx 配置: ${NGINX_CONF}"
fi

# 5. 先落盘不可变版本目录，再原子切换动态清单（零中间态）
echo "[4/6] 发布不可变版本目录与原子清单至 ${SITE_ROOT}/downloads/..."
CHAN_DIR="${SITE_ROOT}/downloads/windows/x64/${CHANNEL}"
SEQ_DIR="${CHAN_DIR}/${SEQ}"
mkdir -p "${SEQ_DIR}/components" "${SITE_ROOT}/downloads"

for f in Jiangjie-Setup-Online-x64.exe Jiangjie-Setup-Offline-x64.exe Jiangjie-Setup-Offline-x64.exe.blockmap SHA256SUMS.txt releases.win.json feed.json "${YAML_FILE}"; do
  if [ -f "$WORK_DIR/assets/$f" ]; then
    cp -f "$WORK_DIR/assets/$f" "${SEQ_DIR}/${f}.tmp"
    mv -f "${SEQ_DIR}/${f}.tmp" "${SEQ_DIR}/${f}"
  fi
done
if [ -d "$WORK_DIR/assets/components" ]; then
  for comp in "$WORK_DIR/assets/components"/component-*.tar.gz; do
    [ -f "$comp" ] || continue
    base="$(basename "$comp")"
    cp -f "$comp" "${SEQ_DIR}/components/${base}.tmp"
    mv -f "${SEQ_DIR}/components/${base}.tmp" "${SEQ_DIR}/components/${base}"
  done
fi

# 原子更新通道级兜底在线引导器与动态更新清单
for f in Jiangjie-Setup-Online-x64.exe feed.json releases.win.json "${YAML_FILE}" SHA256SUMS.txt; do
  if [ -f "$WORK_DIR/assets/$f" ]; then
    cp -f "$WORK_DIR/assets/$f" "${CHAN_DIR}/${f}.tmp"
    mv -f "${CHAN_DIR}/${f}.tmp" "${CHAN_DIR}/${f}"
  fi
done

# 保留现有 macOS DMG 信息（若已有），并原子更新官网 release-manifest.json
python3 - "$WORK_DIR/assets/release-manifest.json" "${SITE_ROOT}/downloads/release-manifest.json" "${SITE_ROOT}/downloads" "$CHANNEL" <<'PY'
import hashlib, json, os, sys
new_path, dst_path, dl_root, channel = sys.argv[1:5]
manifest = json.load(open(new_path, encoding="utf-8"))
manifest["defaultChannel"] = channel
plats = manifest["channels"][channel]["platforms"]

# 如果服务器上已有 macOS DMG 且新清单未包含 macos-arm64，自动补充以保持 Mac 下载按钮可用
if "macos-arm64" not in plats:
    dmg_candidates = [f for f in os.listdir(dl_root) if f.endswith(".dmg") and os.path.isfile(os.path.join(dl_root, f))]
    dmg_candidates.sort(reverse=True)
    if dmg_candidates:
        dmg = dmg_candidates[0]
        full = os.path.join(dl_root, dmg)
        h = hashlib.sha256()
        with open(full, "rb") as fp:
            for chunk in iter(lambda: fp.read(1024 * 1024), b""):
                h.update(chunk)
        plats["macos-arm64"] = {
            "version": manifest["channels"][channel]["version"],
            "publishedAt": manifest["channels"][channel]["publishedAt"],
            "minOs": "macOS 14.0+ (Apple Silicon)",
            "installer": {
                "fileName": dmg,
                "url": f"/downloads/{dmg}",
                "sizeBytes": os.path.getsize(full),
                "sha256": h.hexdigest(),
            },
        }
        print(f"  -> 自动保留现有 macOS DMG: /downloads/{dmg}")

tmp = dst_path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fp:
    json.dump(manifest, fp, ensure_ascii=False, indent=2)
    fp.write("\n")
os.replace(tmp, dst_path)
PY

# 6. 更新官网前端下载页与 Nginx /downloads/ 路由
echo "[5/6] 更新官网下载页脚本与 Nginx Range/缓存规则..."
RAW_BASE="https://raw.githubusercontent.com/${GITHUB_REPO}/${GIT_REF}"
curl -fsSL "${RAW_BASE}/frontend/public/site/downloads.js" -o "${SITE_ROOT}/downloads.js.tmp"
mv -f "${SITE_ROOT}/downloads.js.tmp" "${SITE_ROOT}/downloads.js"

if [ "$SKIP_SITE_HTML" != "1" ]; then
  curl -fsSL "${RAW_BASE}/frontend/public/site/index.html" -o "${SITE_ROOT}/index.html.tmp"
  mv -f "${SITE_ROOT}/index.html.tmp" "${SITE_ROOT}/index.html"
fi

if [ -n "$NGINX_CONF" ] && [ -f "$NGINX_CONF" ]; then
  if ! grep -q "location \^~ /downloads/" "$NGINX_CONF"; then
    python3 - "$NGINX_CONF" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
snippet = """    # Release manifests & auto-update feeds: always revalidate via ETag
    location ~ ^/downloads/.*\\.(?:json|yml|yaml)$ {
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options "nosniff";
        try_files $uri =404;
    }
    # Immutable versioned installers, component archives & blockmaps (supports HTTP Range resume)
    location ^~ /downloads/ {
        etag on;
        add_header Accept-Ranges bytes;
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header X-Content-Type-Options "nosniff";
        try_files $uri =404;
    }
"""
anchor = "    location / {"
if anchor not in text:
    raise SystemExit("未能在 Nginx 配置中找到 'location / {' 锚点，请手动参照 scripts/jiangjie-preview.nginx.conf 补充 /downloads/ 规则。")
updated = text.replace(anchor, snippet + anchor, 1)
open(path, "w", encoding="utf-8").write(updated)
print(f"  -> 已向 {path} 注入 /downloads/ Nginx 缓存与 Range 规则。")
PY
    nginx -t
    systemctl reload nginx || nginx -s reload
  else
    echo "  -> Nginx 已包含 /downloads/ 规则，跳过修改。"
  fi
fi

# 7. 公网自检（HTTP 200 清单 + HTTP 206 Range 断点续传）
echo "[6/6] 执行线上 HTTPS 自检..."
curl -fsSI "https://jiangjie.gingers.cloud/downloads/release-manifest.json" | grep -iE "^HTTP/|cache-control|content-type"
curl -fsSI -H "Range: bytes=0-1023" "https://jiangjie.gingers.cloud/downloads/windows/x64/${CHANNEL}/${SEQ}/Jiangjie-Setup-Offline-x64.exe" | grep -iE "^HTTP/.* 206|accept-ranges|content-range|etag"

echo "======================================================================"
echo " 上线成功！现在打开 https://jiangjie.gingers.cloud/#downloads 即可下载 v${VERSION} (${CHANNEL}, seq=${SEQ})"
echo " 如需回滚，可执行："
echo "   cp -af ${BAK_DIR}/index.html ${SITE_ROOT}/index.html 2>/dev/null || true"
echo "   cp -af ${BAK_DIR}/downloads.js ${SITE_ROOT}/downloads.js 2>/dev/null || true"
echo "   cp -af ${BAK_DIR}/release-manifest.json ${SITE_ROOT}/downloads/release-manifest.json 2>/dev/null || true"
if [ -n "$NGINX_CONF" ]; then
  echo "   cp -af ${BAK_DIR}/nginx.conf ${NGINX_CONF} && nginx -t && systemctl reload nginx"
fi
echo "======================================================================"
