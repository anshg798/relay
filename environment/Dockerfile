# Sandbox for the Relay task. The agent works in /workspace; the lifecycle
# scripts build and run the solution in this same image.
# Build from the repository root:  docker build -f environment/Dockerfile -t relay-env .
FROM node:20-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates python3 procps patch \
 && rm -rf /var/lib/apt/lists/*

# Only model-facing material is copied in. reference/ and evaluation/ never enter the image.
WORKDIR /workspace
COPY task/public/ /workspace/
COPY task/instruction.md /workspace/INSTRUCTIONS.md

# Pre-install the starter's toolchain so the agent can build offline.
RUN npm install --no-audit --no-fund --loglevel=error

ENV PORT=8080 \
    DATA_DIR=/workspace/data \
    NODE_ENV=development
EXPOSE 8080
CMD ["bash"]
