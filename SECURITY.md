# Security policy

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/Arjia-Labs/sark/security/advisories/new).
Please don't open a public issue for anything exploitable.

Include what you'd want if you were fixing it: what you did, what happened, and why it
matters. A concrete request or Slack payload beats a description. Expect a first reply
within a week.

`sark` is a side project with no paid bounty. Credit in the advisory if you'd like it.

## What this project is trying to defend against

The threat model is the reason the project exists, so it's worth stating plainly.

**The sandbox is not trusted.** It runs a model that reads text written by anyone in a Slack
channel, and it has a shell. The design assumes it can misbehave and bounds what that costs:
a compromised box can post into exactly one Slack thread, for at most 12 hours, at a bounded
rate, and can reach nothing else.

Findings that break one of these are in scope, and interesting:

- A sandbox posting into a thread other than its own, or into a channel it was never given.
- A token outliving its box generation, its thread, or its 12-hour expiry.
- Bypassing the allowlist on `/slack/events`, or reaching a control without passing
  `isAllowed`.
- Forging a Slack request that passes `verifySlackSignature`.
- Making a `/mcp` request act on a thread other than the one named by its token.
- Prompt injection that gets the agent to attribute a request to the wrong user, or to treat
  message content as instructions that override the system prompt.
- Using `/mcp` as an amplifier past its batch and body limits.
- A credential appearing anywhere it shouldn't: logs, error text shown to users, box env, or
  a file left behind in a sandbox.

See [the security model](https://arjia-labs.github.io/sark/docs/security) for how each of
these is currently bounded.

## Known and accepted

These are documented tradeoffs rather than bugs. Reports are still welcome if you can show
the impact is worse than described.

**`API_TOKEN` is full bot authority.** `/api` deliberately bypasses the Slack allowlist. A
caller can address any thread id and, by passing `slack` coordinates, make the bot post into
any conversation its token can reach. Guard it like the bot token.

**Forking has a credential window.** A forked filesystem inherits the parent's MCP
registration, so until it re-registers the fork holds a token naming the *parent* thread.
Forked sessions re-register as soon as the box is ready rather than waiting for a mention,
but the window is the fork's provisioning time and is not zero.

**`reactions:read` is broad.** Driving a thread by reaction means the app sees every reaction
in allowlisted channels. Only the six control emoji are acted on, but that's a policy in
code, not a permission boundary. The buttons need no such scope.

**Desktop links are public.** `🖥️`/`Watch` requests a URL with `publicAccess`, so anyone
holding the link can view that sandbox. It's posted into the thread with that warning.

## Out of scope

- Anything requiring a valid `API_TOKEN`, `BOX_API_KEY`, or Slack bot token you already hold.
- What the agent chooses to do inside its own sandbox. That's the sandbox's job to contain,
  and it's [ascii.dev Box](https://docs.ascii.dev/box/api/v1)'s boundary, not this project's.
- Vulnerabilities in Cloudflare Workers, Slack, or the Box API themselves. Report those to
  the relevant vendor.
- Missing hardening with no demonstrated impact.

## Operational notes

`.dev.vars` and `.env` are gitignored and must stay that way. The committed
`wrangler.jsonc` holds placeholders on purpose: no `account_id`, no real origin, and empty
allowlists. If you fork this repo and fill them in, don't push those values back.

Rotating secrets and what each rotation breaks is covered in
[operations](https://arjia-labs.github.io/sark/docs/operations).
