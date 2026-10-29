# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's **[private vulnerability reporting](https://github.com/isaacrowntree/durable-sync/security/advisories/new)**
(Security → Report a vulnerability). Include what you found, how to reproduce
it, and the impact. You'll get a response as soon as reasonably possible, and
credit in the release notes if you'd like it.

## Scope

**In scope:** flaws in this library — one journal's ops reaching another
client, a client draining its outbox without the journal holding the ops
(losing a write), a push or pull that gets past the journal's limits, a
cursor or epoch that can make a client silently stop syncing, or a crafted
op that breaks the journal for its owner.

**Out of scope:** authentication and which journal a request reaches. The
library has no auth: the app's route picks the Durable Object (one per
account, `idFromName(accountId)`), and that key is the isolation boundary.
Also out of scope: what an app's `apply` does with a payload, and which
journal methods its routes expose (never `reset`).

## Supported versions

Fixes land on `main` and ship as a patch release. Please test against the
latest release before reporting.

## Design notes for reviewers

- Isolation: one Durable Object per account. Nothing in an op or a request
  selects a journal; the app's route does, from its own session.
- Access: the journal is Durable Object RPC with no `fetch` handler, so it's
  reachable only from the app's own Worker, and only through the methods the
  app forwards.
- Idempotency: `opId` is unique in the log. A retried push stores nothing
  twice and still names the op as `stored`, so the client can drain it.
- Draining: the client removes from its outbox only the opIds a reply names
  as `stored` (or `rejected`, after `onRejected`), and only from a reply that
  is demonstrably the journal's — never on `res.ok` alone, which an auth
  proxy's login page satisfies.
- Limits (`DEFAULT_LIMITS`): opId 256 chars, kind 128, payload 256 KiB, 1,000
  ops considered a push, 256 MiB a journal, pull pages of 5,000 ops or 4 MiB.
  Sizes are UTF-8 bytes. A full journal refuses in order and the client keeps
  what wasn't stored.
- Epochs: `reset()` starts a new epoch, so every client replays rather than
  holding a cursor into a log that no longer exists.
- SQL: every query binds its values; nothing is built from client input.
