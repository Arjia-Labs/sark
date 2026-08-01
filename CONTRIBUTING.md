# Contributing

PRs welcome. Before sending:

```bash
npm run typecheck
npm test
```

Both run in CI on every PR, so a red tree won't merge.

## Getting set up

You need Node 22+, a [Box](https://docs.ascii.dev/box/api/v1) account, and the `box` CLI.
Slack is optional — the `/api` surface exercises the whole pipeline without it, which is the
easiest way to work on this.

```bash
npm install
npm run dev-vars     # writes .dev.vars from your box CLI login
npm run dev          # local worker on :8787
npm run drive -- --thread demo "create hello.txt and tell me what you did"
```

Note that a local worker isn't publicly reachable, so the sandbox can't call `/mcp` and the
run exercises the watchdog fallback instead. Full end-to-end work goes against a deployed
Worker — see [AGENTS.md](AGENTS.md) for that.

`npm run smoke` checks your Box credentials and template without involving the Worker at all,
and is the fastest way to tell "my setup is broken" from "my change is broken".

## What this project is trying to be

Small. It's a control plane for Box sandboxes with a Slack front end, and the
[Not in scope](README.md#-not-in-scope) list is meant seriously. Changes that make it a
general Slack framework, a job queue, or a multi-tenant service are probably not the right
direction — open an issue before building one.

## Conventions

**Comments explain why, not what.** The codebase leans on this heavily. If a line looks
strange, there's usually a reason it's that way and the reason is written down. When you
change such a line, update the reason. When you add a workaround, say what it works around.

**The sandbox is untrusted.** Anything reaching `/mcp` comes from a box running a model that
reads text anyone in a Slack channel wrote. Don't add a tool parameter that lets a caller
choose a destination; don't widen what a token can address; don't put a credential in box
env, which is fixed at fork time and so can never rotate.

**Errors are split in two.** `publicError()` decides what a user sees; everything else is
log-only. Upstream response bodies and sandbox stderr carry internal identifiers and are
never shown. `SessionError` and `BoxApiError` carry their own public text — use them rather
than leaking a raw message.

**Fail closed.** New gates default to refusing. An empty allowlist refuses everyone, an unset
`API_TOKEN` returns 503, and an unset signing secret refuses traffic rather than accepting it
unverified.

**`Transport` is the seam.** The Durable Object and MCP tools only ever talk to that
interface, which is what makes `MemoryTransport` able to exercise the same code path with no
Slack app. Don't reach for the Slack client from inside the state machine.

**State machine work is parked, not done inline.** Things like a re-run go into storage and
get picked up by the next alarm, so they pass through `ensureBox`/`ensureMcp` and work even
when the box is archived. Resist calling the Box API directly from a handler.

## Tests

`test/*.test.ts` are plain node tests. `test/do/*.test.ts` need a real workerd runtime and
run as a separate vitest project — that's why `vitest.config.ts` deliberately doesn't recurse.

Test the reasoning, not the implementation. The useful tests here are the ones that catch a
silent regression: that the allowlist still refuses when empty, that a token can't outlive
its box generation, that button ids stay unique within a block. A test that just restates
the code isn't worth the maintenance.

## Local settings never go in git

`wrangler.jsonc` is the public template: placeholder origin, empty allowlists, no
`account_id`. Your real values live in `.deploy.env`, which is gitignored, and
`npm run deploy` injects them as wrangler CLI overrides. One config file, so nothing drifts.

`npm run check-config` fails if real values reach the tracked config. It runs in CI, and is
worth installing locally:

```bash
ln -s ../../scripts/check-config-clean.sh .git/hooks/pre-commit
```

It reads the staged copy rather than your working tree, so editing the config locally is
fine — only committing it is not.

## Security

Don't open a public issue for anything exploitable — see [SECURITY.md](SECURITY.md).

## Docs

`docs/` is a [Fumadocs](https://fumadocs.dev) site published to GitHub Pages on push.

```bash
cd docs && pnpm install && pnpm dev
```

The README and the docs site overlap on purpose: the README is the pitch and the quickstart,
the site is the reference. If you change behaviour described in both, change both. Several
pages state security properties as fact, so a change that makes one of those untrue needs the
page updated in the same PR.
