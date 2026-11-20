# Loaded by desktop-dsh.sh inside the installed app.
resources="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
runtime="$resources/runtime"
bin="$resources/../MacOS"
export PATH="$bin:$runtime/python/bin:/usr/bin:/bin:/usr/sbin:/sbin"
unset NODE_PATH NODE_OPTIONS PYTHONHOME PYTHONPATH
export PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1
export VIDEO_KIT_DIR="$resources/video-kit"
export VIDEO_FFMPEG="$bin/ffmpeg"
export VIDEO_FFPROBE="$bin/ffprobe"
export VIDEO_PYTHON="$runtime/python/bin/python3"
export VIDEO_BROWSER="$resources/../Helpers/Chromium.app/Contents/MacOS/Chromium"
export VIDEO_PLAYWRIGHT="$VIDEO_KIT_DIR/node_modules/playwright-core/index.js"
export DSH_CLI="$resources/dsh-workbench-fix/dsh-base/node_modules/.bin/dsh"
