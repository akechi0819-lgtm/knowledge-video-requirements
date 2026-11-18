FROM node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ffmpeg fonts-noto-cjk python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY video-kit/package*.json video-kit/requirements.txt ./video-kit/
RUN npm ci --prefix video-kit && python3 -m venv /opt/video-python && /opt/video-python/bin/pip install --no-cache-dir -r video-kit/requirements.txt
COPY dsh-workbench-fix/dsh-base/package*.json ./dsh-workbench-fix/dsh-base/
RUN npm ci --prefix dsh-workbench-fix/dsh-base
ENV VIDEO_PYTHON=/opt/video-python/bin/python VIDEO_KIT_DIR=/app/video-kit
USER node
