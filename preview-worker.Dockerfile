FROM jiangjie-preview-runtime:local
USER root
COPY scripts/cloud-worker.mjs /app/scripts/cloud-worker.mjs
COPY dsh-workbench-fix/dsh-base/.dsh-home/profiles/workbench/cordis.patch.yml /app/dsh-workbench-fix/dsh-base/.dsh-home/profiles/workbench/cordis.patch.yml
COPY video-kit/WORK /app/video-kit/WORK
COPY video-kit/scripts /app/video-kit/scripts
COPY video-kit/vendor /app/video-kit/vendor
COPY dsh-workbench-fix/dsh-base/packages/bohack-blueprint /app/dsh-workbench-fix/dsh-base/packages/bohack-blueprint
COPY dsh-workbench-fix/dsh-base/workspace/.agents /app/dsh-workbench-fix/dsh-base/workspace/.agents
COPY dsh-workbench-fix/dsh-base/workspace/rules /app/dsh-workbench-fix/dsh-base/workspace/rules
USER node
