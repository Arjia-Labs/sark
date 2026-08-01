import Link from 'next/link'

import { HeroThread } from './hero-thread'

const learningPaths = [
  {
    title: 'Getting started',
    description:
      'Requirements, .dev.vars, and the core loop: trigger a thread, watch it work, archive its sandbox.',
    href: '/docs/getting-started',
    icon: '▶',
    accent: 'oklch(0.78 0.16 60)',
    links: [
      { label: 'Install', href: '/docs/getting-started/install' },
      { label: 'Quickstart', href: '/docs/getting-started/quickstart' },
      { label: 'Deploy', href: '/docs/getting-started/deploy' },
    ],
  },
  {
    title: 'Connect Slack',
    description:
      'Create the app from the manifest, set the two secrets, and opt channels into a fail-closed allowlist.',
    href: '/docs/getting-started/slack',
    icon: '◆',
    accent: 'oklch(0.62 0.16 320)',
    links: [
      { label: 'App manifest', href: '/docs/getting-started/slack#create-the-app' },
      { label: 'Allowlist', href: '/docs/getting-started/slack#the-allowlist' },
      { label: 'Talking to the bot', href: '/docs/getting-started/slack#talking-to-the-bot' },
    ],
  },
  {
    title: 'How it holds together',
    description:
      'One Worker, a Durable Object per thread, a forked sandbox, and a token that can address exactly one of them.',
    href: '/docs/architecture',
    icon: '●',
    accent: 'oklch(0.72 0.15 150)',
    links: [
      { label: 'Architecture', href: '/docs/architecture' },
      { label: 'Thread lifecycle', href: '/docs/lifecycle' },
      { label: 'Security model', href: '/docs/security' },
    ],
  },
]

const categoryCards = [
  {
    title: 'Control API',
    description: 'Six routes behind API_TOKEN that drive a thread with no Slack app at all.',
    href: '/docs/api',
    icon: '⌘',
  },
  {
    title: 'MCP tools',
    description: 'The five tools the agent gets, and why none of them takes a channel.',
    href: '/docs/mcp-tools',
    icon: '🔌',
  },
  {
    title: 'Configuration',
    description: 'Every var and secret in wrangler.jsonc, with what happens if you leave it unset.',
    href: '/docs/configuration',
    icon: '⚙',
  },
  {
    title: 'CLI scripts',
    description: 'drive, smoke, and dev-vars: the three scripts you actually run.',
    href: '/docs/cli',
    icon: '⌨',
  },
  {
    title: 'Controls',
    description: 'Six actions that drive a thread — stop, re-run, escalate, fork, watch, archive — as contextual buttons or reactions.',
    href: '/docs/controls',
    icon: '🛑',
  },
  {
    title: 'Prompt construction',
    description: 'Batched turns, per-message attribution, and delimiter neutralization.',
    href: '/docs/prompts',
    icon: '✎',
  },
  {
    title: 'FAQ',
    description: 'What sark is not, and why.',
    href: '/docs/faq',
    icon: '?',
  },
]

export default function HomePage() {
  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden px-6 py-16 md:py-24">
      <div className="grid-backdrop pointer-events-none absolute inset-0 -z-10" />
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(ellipse 60% 50% at 50% 20%, oklch(0.78 0.16 60 / 10%) 0%, transparent 70%), radial-gradient(ellipse 40% 40% at 75% 70%, oklch(0.62 0.16 320 / 6%) 0%, transparent 70%)',
        }}
      />

      {/* Hero */}
      <div className="animate-fade-in-up mx-auto w-full max-w-5xl">
        <div
          className="relative overflow-hidden rounded-2xl border p-8 md:p-10"
          style={{
            borderColor: 'oklch(1 0 0 / 10%)',
            background: 'linear-gradient(135deg, oklch(1 0 0 / 3%) 0%, transparent 100%)',
          }}
        >
          <div
            className="absolute top-0 left-0 h-28 w-28 rounded-tl-2xl"
            style={{
              borderLeft: '2px solid oklch(0.78 0.16 60 / 25%)',
              borderTop: '2px solid oklch(0.78 0.16 60 / 25%)',
            }}
          />
          <div
            className="absolute right-0 bottom-0 h-28 w-28 rounded-br-2xl"
            style={{
              borderRight: '2px solid oklch(0.62 0.16 320 / 25%)',
              borderBottom: '2px solid oklch(0.62 0.16 320 / 25%)',
            }}
          />

          <div className="grid items-center gap-10 md:grid-cols-2">
            <div>
              <h1
                className="text-5xl md:text-6xl"
                style={{
                  fontFamily: 'var(--font-orbitron), sans-serif',
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                }}
              >
                sark
              </h1>
              <p className="text-fd-muted-foreground mt-4 text-lg">
                Mention a bot in Slack; it forks a cloud sandbox for that thread and runs a coding
                agent inside it.
              </p>
              <p className="text-fd-muted-foreground mt-3 text-sm">
                One Worker, a Durable Object per thread, thread-scoped MCP tokens, and an allowlist
                that fails closed.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link
                  href="/docs/getting-started/quickstart"
                  className="rounded-lg px-5 py-2.5 text-sm font-medium"
                  style={{
                    background: 'var(--color-fd-primary)',
                    color: 'var(--color-fd-primary-foreground)',
                  }}
                >
                  Quickstart
                </Link>
                <Link
                  href="/docs"
                  className="rounded-lg border px-5 py-2.5 text-sm font-medium"
                  style={{ borderColor: 'oklch(1 0 0 / 15%)' }}
                >
                  Read the docs
                </Link>
              </div>
            </div>

            <HeroThread />
          </div>
        </div>
      </div>

      {/* Learning paths */}
      <div className="mx-auto mt-14 w-full max-w-5xl">
        <div className="grid gap-5 md:grid-cols-3">
          {learningPaths.map((p) => (
            <div
              key={p.title}
              className="rounded-xl border p-6"
              style={{ borderColor: 'oklch(1 0 0 / 10%)' }}
            >
              <div className="text-2xl" style={{ color: p.accent }}>
                {p.icon}
              </div>
              <Link href={p.href} className="mt-3 block text-lg font-semibold hover:underline">
                {p.title}
              </Link>
              <p className="text-fd-muted-foreground mt-2 text-sm">{p.description}</p>
              <ul className="mt-4 space-y-1.5 text-sm">
                {p.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="text-fd-muted-foreground hover:text-fd-foreground">
                      → {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Reference cards */}
      <div className="mx-auto mt-10 w-full max-w-5xl">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {categoryCards.map((c) => (
            <Link
              key={c.href}
              href={c.href}
              className="hover:bg-fd-accent/40 rounded-xl border p-5 transition-colors"
              style={{ borderColor: 'oklch(1 0 0 / 8%)' }}
            >
              <div className="text-xl">{c.icon}</div>
              <div className="mt-2 font-semibold">{c.title}</div>
              <p className="text-fd-muted-foreground mt-1 text-sm">{c.description}</p>
            </Link>
          ))}
        </div>
      </div>

      <p className="text-fd-muted-foreground mx-auto mt-14 text-center text-xs">End of line.</p>
    </main>
  )
}
