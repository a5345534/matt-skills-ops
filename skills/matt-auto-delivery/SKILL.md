---
name: matt-auto-delivery
description: >
  After grilling, ADRs, or domain docs, offer Matt Auto delivery instead of
  hand-implementing a multi-ticket feature. Use when design is agreed, the user
  asks what to do next after grill/ADR, or you are about to implement a whole
  feature in Workflow home. Points to /matt-auto run (to-spec → tickets →
  workers → PR). Not for tiny one-off edits or bugfixes the user asked to code now.
---

# Matt Auto delivery (post-discovery)

You are in a session where **Matt Auto** is installed. Multi-ticket feature shipping is **not** "keep coding in this chat" by default.

## When this applies

- Grill / grill-with-docs / grilling just reached shared understanding
- ADRs or CONTEXT were just landed for something still unbuilt
- User asks "next steps", "how do we ship this", or similar after design
- You are about to implement a full feature across many files/tickets yourself

## What to do

1. **Do not** start a large product implementation in Workflow home unprompted.
2. **Summarize** that design/docs are captured (if they are).
3. **Ask explicitly** whether to start Matt Auto, naming the command:

   > Start delivery with `/matt-auto run` (Create-spec → Create-tickets → implement workers → Integration → PR)? Or stay docs-only for now?

4. If they say yes → tell them to run **`/matt-auto run`** (or run it only if your environment can invoke slash commands; otherwise instruct them to type it).
5. If they say docs-only / not yet → stop after docs. Do not implement.

## What not to do

- Do not silently open a long implement pass for a multi-ticket feature
- Do not skip offering Matt Auto because the user "might not know the command"
- Do not use this path for a one-line fix or a bug they asked you to fix **in this turn**

## Commands

| Command | Role |
|---------|------|
| `/matt-auto` | Menu / status |
| `/matt-auto next` | One stage step |
| `/matt-auto run` | Auto-advance full post-grill pipeline |
