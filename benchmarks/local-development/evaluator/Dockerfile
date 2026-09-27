# Explicit preparation only. The benchmark runner never builds or pulls images.
# Bases match the currently shipped stack; the resulting image ID pins all
# resolved OS/Python/npm/browser dependencies for repeated evaluations.
FROM node:24-bookworm-slim AS node
FROM python:3.12-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && apt-get update \
    && apt-get install -y --no-install-recommends chromium libatomic1 \
    && rm -rf /var/lib/apt/lists/*
COPY resources/app-skeletons/vite-fastapi-sqlite/backend /opt/backend
COPY resources/app-skeletons/vite-fastapi-sqlite/frontend/package.json /opt/frontend/package.json
# The pinned skeleton inspects the pre-0.137 flat router contract. FastAPI
# 0.137 changes routes to a tree; preserve its existing regression assertions.
RUN python -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install '/opt/backend[dev]' 'fastapi==0.136.3' \
    && npm install --prefix /opt/frontend \
    && npm install --prefix /opt/evaluator --save-exact playwright@1.62.1
ENV PATH="/opt/venv/bin:/usr/local/bin:/usr/bin:/bin" \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HOME=/tmp npm_config_cache=/tmp/npm
RUN /opt/venv/bin/python -m pip freeze > /opt/python-dependencies.txt \
    && npm list --prefix /opt/frontend --json > /opt/frontend-dependencies.json \
    && chmod -R a+rX /opt \
    && mkdir -p /work/app/backend /work/app/frontend /scratch
USER 1000:1000
WORKDIR /work
