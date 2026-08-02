# Vision — the agent-native tracker

This document is the tiebreaker. When a feature idea, a review comment, or a
roadmap debate needs a ruling, the answer comes from here.

## The gap

Every incumbent tracker — Jira, Azure DevOps, GitHub Issues, Linear, Monday,
Asana — is a human product with agents bolted on. Tracking is implemented as
forms humans fill and boards humans read. None of them is built for a team
where agents do most of the work. quest is.

## What a tracker actually provides

Stripped of its UI, a tracker does five things:

1. **Memory of work** — what needs doing, what's done, why.
2. **Coordination** — who's on what; don't collide.
3. **Sequencing** — what's next.
4. **Context transfer** — handoffs between workers.
5. **Visibility** — status for people not doing the work.

The incumbents implement all five as human ceremony. quest implements all five
as agent primitives and regenerates the human surfaces on demand.

## The design

**The system's primary users are agents. The human interface is language.**

### 1. Nobody fills forms

Work enters through conversation: you tell your agent what broke, and the
agent structures it, checks for duplicates, files it, and attaches the
evidence. Same on the way out — instead of opening a board, you ask your agent
for the picture you need, and it renders a table or a one-line answer from the
primitives and throws it away after. Human views are generated, not
maintained.

### 2. The ticket compiles into a briefing

Agents start every session cold, so the real unit of work is not
title-plus-description — it's a resumable context package: what's known, what
was tried, which files, prior attempts and their evidence. `quest brief <id>`
emits all of it in one command. The tracker is shared memory for workers who
have none of their own.

### 3. Coordination built for things that crash

Claims are atomic, and they're leases, not locks: an agent that dies loses its
claim after a timeout, and the next attempt inherits the full trail through
the event log and evidence. Predicted-file warnings keep two agents out of the
same code. Verbs are idempotent so retries are safe. Agents fail all the time;
the system expects it.

### 4. Evidence is the currency

When agents produce most of the work, verification is the human bottleneck.
So proof travels with the work: state transitions carry evidence
(before/after, receipts), completion of PR-backed work requires the PR to be
merged, and the trust ladder is explicit — done by an agent, verified by
another, spot-checked by a human.

### 5. The queue drives the agents

The tracker dispatches: a runner walks the ready queue and spawns worker
agents in isolated git worktrees, each with a named session and its briefing.
Workers claim, work, and turn in with evidence. The human handles what's left:
verdicts, priorities, judgment. Dispatch only runs when a person runs it.

## What deliberately does not exist

Boards. Dashboards. Comment threads. Notification settings. Workflow
configuration. Permission schemes. Each of those is either a view an agent can
render or a behavior an agent can perform, so none of them is product surface.
That is the guard against turning into the tools this replaces — there is no
UI layer to grow features onto.

One exception, added after real use demanded it: a single read-only terminal
viewer — a live glance at the board with zero mutation keys. It's a window,
not a control surface. Because it can't write, it can't grow workflow.

## Where it stands

Built: the verb surface with JSON envelopes and stable exit codes, atomic
claims with leases, chains with cycle rejection, `next` with overlap warnings,
content-addressed evidence, the append-only event log, dedup at intake,
`quest brief`, the dispatcher, merge-gated completion, session attribution
(guild/model/effort), the agent skill, backup/restore, per-repo backends with
a self-hosted Convex option, and member onboarding with invite tokens.

Still ahead: conversational intake as the default human door, and adversarial
verify-by-agent as a first-class stage.

## Principles

- **Build boldly** — nobody sells an agent-native tracker; so it gets built.
- **Primitives, not features** — views are rendered by the user's agent on
  demand, never maintained as product surface.
- **Fight for the obvious solution** — the obvious agent affordance is a CLI
  with structured output, not a web app.
- **Prove it** — evidence-gated transitions make proof the schema, not the
  culture.
