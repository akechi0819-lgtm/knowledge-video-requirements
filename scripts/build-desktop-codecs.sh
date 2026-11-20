#!/bin/bash
# Build self-contained macOS arm64 FFmpeg executables and preserve their source.
set -euo pipefail
if [[ $# != 2 || $1 != /* || $2 != /* ]]; then
  echo "Usage: $0 /absolute/output-bin /absolute/cache" >&2; exit 2
fi
out=$1
cache=$2
mkdir -p "$out" "$cache/sources" "$cache/build" "$cache/prefix" "$cache/licenses"
fetch() {
  local name=$1 url=$2 hash=$3 file="$cache/sources/$1"
  if [[ ! -f "$file" ]]; then
    curl -fL -C - "$url" -o "$file.download"
    echo "$hash  $file.download" | shasum -a 256 -c -
    mv "$file.download" "$file"
  fi
  echo "$hash  $file" | shasum -a 256 -c -
}
fetch ffmpeg-9.0.2.tar.xz https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz 8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
fetch x264-snapshot-20191217-2245.tar.bz2 https://download.videolan.org/pub/videolan/x264/snapshots/x264-snapshot-20191217-2245.tar.bz2 0bb67d095513391e637b3b47e8efc3ba4603c3844f1b4c2690f4d36da7763055
fetch lame-3.100.tar.gz https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
fetch pkgconf-3.0.11.tar.xz https://distfiles.ariadne.space/pkgconf/pkgconf-3.0.11.tar.xz d0cd841bc8e55b9da888106c00dc256d05b7d1d8e5a46f4be4eb4c5125bd2dc4
if [[ -f "$cache/SHA256SUMS" && -f "$cache/build-desktop-codecs.sh" ]] && cmp -s "$0" "$cache/build-desktop-codecs.sh" && (cd "$cache" && shasum -a 256 -c SHA256SUMS); then
  if [[ "$out" != "$cache/bin" ]]; then cp "$cache/bin/ffmpeg" "$cache/bin/ffprobe" "$out/"; fi
  echo "Reused verified desktop codecs from $cache"
  exit 0
fi
rm -f "$cache/SHA256SUMS"
cp "$0" "$cache/build-desktop-codecs.sh"
export MACOSX_DEPLOYMENT_TARGET=13.0
export CFLAGS="-O2 -arch arm64 -mmacosx-version-min=13.0"
export LDFLAGS="-arch arm64 -mmacosx-version-min=13.0"
export PKG_CONFIG_PATH="$cache/prefix/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"
jobs=$(sysctl -n hw.ncpu)
cd "$cache/build"
tar xf "$cache/sources/pkgconf-3.0.11.tar.xz"
cd pkgconf-3.0.11
./configure --prefix="$cache/prefix" --disable-shared --enable-static
make -j"$jobs"
make install
cp COPYING "$cache/licenses/pkgconf-COPYING"
export PATH="$cache/prefix/bin:$PATH"
ln -sf pkgconf "$cache/prefix/bin/pkg-config"
cd "$cache/build"
tar xf "$cache/sources/x264-snapshot-20191217-2245.tar.bz2"
cd x264-snapshot-20191217-2245
./configure --host=aarch64-apple-darwin --prefix="$cache/prefix" --enable-static --disable-cli --disable-opencl
make -j"$jobs"
make install
cp COPYING "$cache/licenses/x264-COPYING"
cd "$cache/build"
tar xf "$cache/sources/lame-3.100.tar.gz"
cd lame-3.100
./configure --prefix="$cache/prefix" --disable-shared --enable-static --disable-frontend
make -j"$jobs"
make install
cp COPYING "$cache/licenses/lame-COPYING"
cd "$cache/build"
tar xf "$cache/sources/ffmpeg-9.0.2.tar.xz"
cd ffmpeg-9.0.2
./configure --prefix="$cache/prefix" --enable-gpl --enable-libx264 --enable-libmp3lame --disable-shared --enable-static --disable-ffplay --disable-autodetect --enable-zlib --extra-cflags="-I$cache/prefix/include $CFLAGS" --extra-ldflags="-L$cache/prefix/lib $LDFLAGS"
make -j"$jobs" ffmpeg ffprobe
mkdir -p "$cache/bin"
cp ffmpeg ffprobe "$cache/bin/"
if [[ "$out" != "$cache/bin" ]]; then cp "$cache/bin/ffmpeg" "$cache/bin/ffprobe" "$out/"; fi
cp COPYING.GPLv2 "$cache/licenses/ffmpeg-COPYING.GPLv2"
"$cache/bin/ffmpeg" -v error -f lavfi -i color=black:s=64x64:r=10 -f lavfi -i sine=frequency=440 -t 0.2 -c:v libx264 -c:a aac -y "$cache/build/smoke.mp4"
"$cache/bin/ffprobe" -v error -show_entries format=duration -of default=nw=1 "$cache/build/smoke.mp4"
"$cache/bin/ffmpeg" -v error -i "$cache/build/smoke.mp4" -frames:v 1 -update 1 -y "$cache/build/smoke.png"
"$cache/bin/ffmpeg" -v error -i "$cache/build/smoke.png" -f null -
"$cache/bin/ffmpeg" -v error -f lavfi -i sine=frequency=440 -t 0.2 -c:a libmp3lame -f mp3 -y "$cache/build/smoke.mp3"
"$cache/bin/ffmpeg" -hide_banner -filters > "$cache/build/filters.txt"
for filter in ebur128 freezedetect acompressor; do grep -E "[[:space:]]$filter[[:space:]]" "$cache/build/filters.txt" >/dev/null; done
for bin in ffmpeg ffprobe; do
  lipo -verify_arch arm64 "$cache/bin/$bin"
  if otool -L "$cache/bin/$bin" | tail -n +2 | awk '{print $1}' | grep -Ev '^(/usr/lib/|/System/Library/)' ; then
    echo "Non-system dynamic dependency in $bin" >&2; exit 1
  fi
done
(cd "$cache" && shasum -a 256 sources/ffmpeg-9.0.2.tar.xz sources/x264-snapshot-20191217-2245.tar.bz2 sources/lame-3.100.tar.gz sources/pkgconf-3.0.11.tar.xz build-desktop-codecs.sh bin/ffmpeg bin/ffprobe > SHA256SUMS)
echo "Built $out/ffmpeg and $out/ffprobe; source and licenses: $cache"
