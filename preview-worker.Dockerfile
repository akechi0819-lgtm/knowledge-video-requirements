FROM jiangjie-preview-runtime:local
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY scripts/cloud-worker.mjs /app/scripts/cloud-worker.mjs
COPY dsh-workbench-fix/dsh-base/.dsh-home/profiles/workbench/cordis.patch.yml /app/dsh-workbench-fix/dsh-base/.dsh-home/profiles/workbench/cordis.patch.yml
COPY video-kit/WORK /app/video-kit/WORK
COPY video-kit/scripts /app/video-kit/scripts
COPY video-kit/vendor /app/video-kit/vendor
COPY dsh-workbench-fix/dsh-base/packages/bohack-blueprint /app/dsh-workbench-fix/dsh-base/packages/bohack-blueprint
COPY dsh-workbench-fix/dsh-base/workspace/.agents /app/dsh-workbench-fix/dsh-base/workspace/.agents
COPY dsh-workbench-fix/dsh-base/workspace/rules /app/dsh-workbench-fix/dsh-base/workspace/rules
COPY .project-skills/andy-vibe-knowledge/skills/vibe-knowledge /app/.agents/skills/andy-vibe-knowledge
COPY .project-skills/andy-vibe-knowledge/skills/ai-teardown /app/.agents/skills/ai-teardown
COPY .project-skills/deepseek-opus-motion-skill/motion-design-prompt-generator /app/.agents/skills/motion-design-prompt-generator
COPY .project-skills/vibe-knowledge-film/SKILL.md .project-skills/vibe-knowledge-film/LICENSE .project-skills/vibe-knowledge-film/README.md /app/.agents/skills/vibe-knowledge-film/
COPY .project-skills/vibe-knowledge-film/engine /app/.agents/skills/vibe-knowledge-film/engine
COPY .project-skills/vibe-knowledge-film/references /app/.agents/skills/vibe-knowledge-film/references
COPY .project-skills/vibe-knowledge-film/scripts /app/.agents/skills/vibe-knowledge-film/scripts
COPY .project-skills/vibe-knowledge-film/examples /app/.agents/skills/vibe-knowledge-film/examples
USER node
