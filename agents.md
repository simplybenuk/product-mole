# Agents

This repository keeps its agent operating rules in `0-bootstrap/agents.md`.

Agents running from tools or workflows that expect a root-level `agents.md` should treat this file as the entrypoint and then follow:

1. `0-bootstrap/agents.md`
2. `1-routing/task-types.md`
3. the smallest relevant summaries and indexes
4. context modules only as needed
5. evidence and raw material only when required

