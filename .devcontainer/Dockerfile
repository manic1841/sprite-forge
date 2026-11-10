# Development image for sprite-forge.
#
# Node 22 (LTS) on Debian bookworm gives a glibc toolchain, which is what
# sharp's prebuilt binaries expect. The repo needs Node >= 20 (see package.json),
# plus the native toolchain for the odd package that compiles from source.
FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# Build tooling for optional native modules (sharp already ships prebuilts, but
# keep the image usable if a dependency ever falls back to node-gyp).
RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
        pkg-config \
        libvips-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# pnpm is the package manager for this repo (pnpm-lock.yaml, lockfileVersion 9).
RUN corepack enable && corepack prepare pnpm@10 --activate

# Node user lands here by default; make the pnpm store and the workspace usable.
# The store directory is normally shadowed by the named volume declared in
# devcontainer.json, whose mount point Docker creates root-owned — that case is
# repaired in postCreateCommand/postStartCommand. This mkdir/chown covers the
# image-only case where no volume is mounted.
RUN mkdir -p /home/node/.local/share/pnpm/store \
    && chown -R node:node /home/node/.local /home/node/.config
