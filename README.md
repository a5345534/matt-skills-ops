# Matt Auto

Stage-gated workflow orchestration for [Pi Coding Agent](https://pi.dev).

Matt Auto is a reusable Pi package. From Workflow home, run:

- `/matt-auto` — interactive menu (Workflow preflight + Next actions)
- `/matt-auto next` — only currently available Next actions

V1 is stage-gated and menu-driven. Product behavior is owned by the **Workflow coordinator** seam; Pi, git/gh, skills, and workspace adapters sit outside that seam.

## Install

```bash
# From a local checkout
pi install /absolute/path/to/matt-skills-ops

# Project-local
pi install -l /absolute/path/to/matt-skills-ops
```

## Develop

```bash
npm install
npm test
npm run typecheck
```

Load the extension without installing:

```bash
pi -e ./extensions/matt-auto.ts
```

## Workflow preflight

Preflight checks (fail closed, no bootstrap inventing):

1. GitHub remote on the Workflow root
2. `gh` authentication
3. Target branch (default `main`, overridable per root)
4. Required Matt skills: `to-spec`, `to-tickets`, `implement`, `resolving-merge-conflicts`
5. Worker profile presence (model + thinking level)

Preferences live under:

- Global: `~/.pi/agent/matt-auto/preferences.json`
- Workflow root: `.pi/matt-auto/preferences.json`

Example Worker profile:

```json
{
  "workerProfile": {
    "modelId": "claude-sonnet-4",
    "thinkingLevel": "medium"
  }
}
```

## Status

Ticket #2 establishes the package shell, coordinator seam, and preflight menus. Planning stages, workers, integration, CI, and Workflow PR land in later tickets.
