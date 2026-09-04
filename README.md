# Codex Docker

A small Debian-based Docker image for running the OpenAI Codex CLI in an
isolated workspace. It includes Node.js 22, Git, Bubblewrap, and terminal
defaults suited to interactive Codex sessions.

## Usage

```sh
docker build -t codex .
docker run -d --name codex -v "$PWD:/workspace" codex
docker exec -it codex bash
```

Inside the container, run `codex` to start Codex with full workspace access.
