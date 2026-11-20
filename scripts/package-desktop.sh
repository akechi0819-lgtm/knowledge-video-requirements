#!/bin/bash
set -euo pipefail
if [[ $# != 2 || ! -d "$1/Contents" || "$2" != *.dmg || -e "$2" ]]; then
  echo '用法：package-desktop.sh /path/to/讲界.app /path/to/新的安装包.dmg' >&2
  exit 2
fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
app="$1"
dmg="$2"
profile="${JIANGJIE_NOTARY_PROFILE:-}"
identity="${JIANGJIE_SIGN_IDENTITY:--}"
codesign --verify --deep --strict "$app"
if [[ "$identity" != - ]]; then
  codesign -v -R='anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' "$app"
elif [[ -n "$profile" ]]; then
  echo '申请公证需要先用 Developer ID Application 签名构建 App。' >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/讲界.app"
ln -s /Applications "$stage/Applications"
tar -czf "$stage/编解码器对应源码.tar.gz" -C "$repo/.runtime/desktop-codec-cache" \
  sources licenses build-desktop-codecs.sh
hdiutil create -quiet -volname '讲界' -srcfolder "$stage" -fs HFS+ -format UDZO "$dmg"
if [[ "$identity" != - ]]; then
  codesign --sign "$identity" --timestamp "$dmg"
  codesign --verify "$dmg"
fi
if [[ -n "$profile" ]]; then
  xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait --output-format json | tee "$dmg.notary.json"
  status="$(plutil -extract status raw -o - "$dmg.notary.json")"
  if [[ "$status" != Accepted ]]; then
    submission="$(plutil -extract id raw -o - "$dmg.notary.json")"
    xcrun notarytool log "$submission" --keychain-profile "$profile" "$dmg.notary-log.json"
    echo "Apple 公证状态：$status" >&2
    exit 1
  fi
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl -a -t open --context context:primary-signature -vv "$dmg"
fi
hdiutil verify "$dmg"
