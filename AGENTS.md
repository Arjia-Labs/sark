# AGENTS.md — deploying sark

A runbook for an AI agent asked to clone, configure, and deploy this Cloudflare Worker.
Follow the phases in order. Each ends with a check; **do not continue past a failed check.**

Some steps need a decision only the human can make. Those are marked **ASK** — stop, ask,
and wait. Do not guess a Slack channel id, a billing plan, or an allowlist.

## Rules

- **Never print a secret value.** Not in output, not in a commit, not in a comment. Pipe
  secrets through stdin. If one is ever echoed, say so and tell the human to rotate it.
- **Never commit `.dev.vars` or `.env`.** Both are gitignored. Keep it that way.
- **Never put personal settings in `wrangler.jsonc`.** It is the public template. Worker
  name, origin, allowlist, and template box id go in `.deploy.env` (gitignored) and are
  injected by `npm run deploy`. `account_id` comes from `CLOUDFLARE_ACCOUNT_ID`.
  `npm run check-config` enforces this, and it runs in CI.
- If a command fails twice the same way, stop and report. Do not improvise around the
  Cloudflare or Box APIs.

## Phase 0 — prerequisites

```bash
node --version          # must be >= 22
git --version
npx wrangler --version
```

**ASK the human to confirm all three before you touch anything:**

1. **A Cloudflare account on a paid Workers plan.** The per-thread state machine is a
   Durable Object with a SQLite backend, which the free plan does not offer. Deploy will
   fail at the migration step otherwise.
2. **An [ascii.dev Box](https://docs.ascii.dev/box/api/v1) account** and a `box_...` API
   key. This Worker is a control plane for Box sandboxes and does nothing without one.
3. **Whether Slack is wanted at all.** It is optional; the `/api` surface exercises the
   entire pipeline without a Slack app. If they say no, skip Phase 5.

Authenticate to Cloudflare, whichever the human prefers:

```bash
npx wrangler login                       # interactive, opens a browser
# or export CLOUDFLARE_API_TOKEN=...     # a token with Workers Scripts:Edit
export CLOUDFLARE_ACCOUNT_ID=...         # required either way
```

**Check:** `npx wrangler whoami` prints an account.

## Phase 1 — clone and verify the tree

```bash
git clone <repo-url> sark && cd sark
npm ci
npm run typecheck
npm test
```

**Check:** typecheck prints nothing and every test passes. A red tree here is a repo
problem, not a deployment problem — report it and stop.

## Phase 2 — Box credentials

If the human has the `box` CLI installed and logged in:

```bash
npm run dev-vars
```

That reads the `box` CLI's own config, copies the `box_...` key into `.dev.vars`, and
generates random values for `MCP_TOKEN_SECRET` and `API_TOKEN`. No secret is typed, pasted,
or echoed. It refuses to overwrite an existing `.dev.vars`.

If the CLI is not available, ask the human to create `.dev.vars` themselves:

```
BOX_API_KEY=box_...
MCP_TOKEN_SECRET=<64 random hex chars>
API_TOKEN=<64 random hex chars>
```

Verify the key actually works before deploying anything:

```bash
npm run smoke
```

This creates a box, runs a command, prompts the agent, reads a file back, and stops the box.
It talks to Box directly and does not involve the Worker.

**Check:** smoke exits 0 and prints a box id and at least one response event. If it fails on
auth, the key is wrong. Stop.

## Phase 3 — first deploy

`PUBLIC_URL` must be the Worker's own public origin, because the sandbox reads it to find
`/mcp`. You cannot know that origin until the Worker exists, so **the first deploy is
expected to run with a placeholder** and is immediately followed by a second.

```bash
npx wrangler secret put BOX_API_KEY        # paste the box_... key
npx wrangler secret put MCP_TOKEN_SECRET   # any long random string
npx wrangler secret put API_TOKEN          # guards /api
npx wrangler deploy --name sark            # first deploy, to learn the origin
```

To set them non-interactively without the value reaching the transcript:

```bash
grep '^BOX_API_KEY=' .dev.vars | cut -d= -f2- | npx wrangler secret put BOX_API_KEY
```

> Use the **same** `API_TOKEN` value as `.dev.vars`, or `npm run drive` will not be able to
> reach the deployed Worker in Phase 6.

Deploy prints the origin, e.g. `https://sark.<subdomain>.workers.dev`. If the account has no
workers.dev subdomain yet, Cloudflare prompts to create one — **ASK** before accepting, since
it claims a name on a shared namespace.

**Check:** `npx wrangler deployments list` shows a deployment.

## Phase 4 — set PUBLIC_URL and redeploy

Put your settings in `.deploy.env` (gitignored — **never** edit `wrangler.jsonc` for this,
it is the public template and CI fails if real values land in it):

```bash
WORKER_NAME=sark
PUBLIC_URL=https://sark.<subdomain>.workers.dev
```

```bash
npm run deploy
curl -s https://sark.<subdomain>.workers.dev/health
```

**Check:** `/health` returns `{"ok":true,...}`. `slack` will be `false` until Phase 5, and
`template` will be `null` until Phase 7. Both are fine.

Until `PUBLIC_URL` is correct, sandboxes cannot call back and every run falls through to the
watchdog path — the thread still gets a reply, recovered from the box event log, but nothing
streams. If runs work but feel wrong, check this first.

## Phase 5 — Slack (skip if the human declined)

Create the app from `slack-manifest.json`. Before uploading it, substitute **both**
`https://<your-worker>.workers.dev` placeholders with the real origin:

- `settings.event_subscriptions.request_url` → `<origin>/slack/events`
- `settings.interactivity.request_url` → `<origin>/slack/interactive`

The manifest already requests the scopes the bot needs, including `reactions:read` for the
emoji controls. Note for the human: that scope means the app sees **every** reaction in
allowlisted channels, though only the six control emoji are acted on.

Install the app, then:

```bash
npx wrangler secret put SLACK_BOT_TOKEN      # xoxb-...
npx wrangler secret put SLACK_SIGNING_SECRET
```

**ASK for the allowlist.** You cannot infer these, and getting them wrong either breaks the
bot or opens it up:

- `ALLOWED_CHANNELS` — comma-separated channel ids (`C...`)
- `ALLOWED_USERS` — comma-separated user ids (`U...`), optional
- `ALLOWED_TEAMS` — workspace id (`T...`), optional but recommended

Set them in `.deploy.env` and redeploy with `npm run deploy`. **The allowlist fails closed:** with both
`ALLOWED_CHANNELS` and `ALLOWED_USERS` empty, every mention is refused. That is deliberate —
it is what stops a public channel from spinning up unbounded sandboxes. An empty allowlist is
a working deployment that ignores everyone, not a broken one.

```bash
npm run deploy
curl -s <origin>/health     # "slack" should now be true
```

Invite the bot to an allowlisted channel and mention it.

## Phase 6 — verify end to end

```bash
export API_TOKEN=$(grep '^API_TOKEN=' .dev.vars | cut -d= -f2-)
npm run drive -- --url <origin> --thread verify "create hello.txt with the word banana and tell me what you did"
npm run drive -- --url <origin> --thread verify "what was in that file?"
npm run drive -- --url <origin> --thread verify --stop
```

**Check:** the first command prints the agent's reply, the second proves the same sandbox and
filesystem were reused, and `--stop` archives it.

Run this against the **deployed** origin, not `localhost`. A local worker is not publicly
reachable, so the box cannot call `/mcp` and the run only exercises the fallback path.

## Phase 7 — template box (optional, recommended)

Without `TEMPLATE_BOX_ID` every thread starts from a bare box. With one, threads fork a
snapshot that already has the stack, repos, and settings.

```bash
box new              # install the stack, clone repos
box stop <id>        # the stopped snapshot IS the template
```

Set `TEMPLATE_BOX_ID` in `.deploy.env` and redeploy. Keep the template stopped; to publish
a new version, resume it, update it, and stop it again.

## Tuning knobs

All in `wrangler.jsonc` under `vars`; all safe to leave at their defaults.

| Var | Default | |
|---|---|---|
| `BOX_PROVIDER` | `claude-code` | which agent runs in the box |
| `BOX_MODEL` | *(empty)* | model override; empty uses the provider default |
| `BOX_TTL_SECONDS` | `3600` | hard box lifetime |
| `IDLE_STOP_SECONDS` | `900` | quiet period before a box is archived |
| `PROMPT_HARD_CAP_SECONDS` | `1200` | wall clock before a run is abandoned |
| `TEMPLATE_BOX_ID` | *(empty)* | snapshot to fork per thread |

## When something is wrong

| Symptom | Cause |
|---|---|
| Deploy fails on the migration | Account is not on a paid Workers plan; Durable Objects with SQLite need one |
| Every mention is refused | Allowlist is empty. This is the fail-closed default, not a bug |
| `/health` shows `slack: false` | `SLACK_BOT_TOKEN` or `SLACK_SIGNING_SECRET` is unset |
| `/slack/events` returns 503 | `SLACK_SIGNING_SECRET` is unset; it refuses unverified traffic |
| `/api` returns 503 | `API_TOKEN` is unset; it fails closed rather than open |
| `/api` returns 401 | The `API_TOKEN` you are sending differs from the deployed secret |
| Replies arrive but never stream | `PUBLIC_URL` is wrong, so the box cannot reach `/mcp` |
| Box operations all fail | `BOX_API_KEY` is wrong or the Box account is out of quota |

Logs: `npx wrangler tail`. Per-thread state: `GET /api/threads/{id}` with the bearer token,
which reports box id, box state, phase, prompt status, `mcpRegistered`, and `lastError`.

## What not to do

- Do not commit `PUBLIC_URL`, `account_id`, or real Slack ids to a fork you intend to share.
  The committed values are placeholders on purpose.
- Do not widen the allowlist to `ALLOWED_CHANNELS` covering a public channel without asking.
  Every mention there forks a sandbox that costs money.
- Do not set `API_TOKEN` to something guessable. It bypasses the Slack allowlist by design
  and can make the bot post into any conversation its Slack token can reach.
- Do not re-enable interactivity for anything beyond the effort dropdown without adding an
  `isAllowed` check to the handler. That gate is the only thing standing between a Block Kit
  payload and the sandbox.
