'use client'

import { useEffect, useState } from 'react'

/**
 * A fake Slack thread that types itself out. Purely decorative, but it mirrors
 * the real sequence a run goes through (mention → status message edited in
 * place → final answer), so it doubles as a one-glance explanation.
 */
const SCRIPT = [
  { kind: 'user', who: 'dana', text: '@sark run the test suite and tell me what broke' },
  { kind: 'status', who: 'sark', text: '⚙️ Starting a sandbox…' },
  { kind: 'status', who: 'sark', text: '🤖 Working… `box_7f21a9`' },
  {
    kind: 'bot',
    who: 'sark',
    text: '2 failures in `auth.test.ts`, both from the clock-skew branch.\nPatch attached.',
  },
  { kind: 'file', who: 'sark', text: '📎 fix-clock-skew.diff' },
] as const

const STEP_MS = 1400

export function HeroThread() {
  const [shown, setShown] = useState(1)

  useEffect(() => {
    if (shown >= SCRIPT.length) return
    const t = setTimeout(() => setShown((n) => n + 1), STEP_MS)
    return () => clearTimeout(t)
  }, [shown])

  // The status line is edited in place in the real product, so collapse
  // consecutive status entries down to the latest one.
  const visible = SCRIPT.slice(0, shown).filter(
    (m, i, all) => m.kind !== 'status' || all[i + 1]?.kind !== 'status',
  )

  return (
    <div
      className="overflow-hidden rounded-xl border font-mono text-[13px] leading-relaxed"
      style={{
        borderColor: 'oklch(1 0 0 / 12%)',
        background: 'oklch(0.14 0.012 40 / 60%)',
      }}
    >
      <div
        className="flex items-center gap-2 border-b px-4 py-2 text-xs"
        style={{ borderColor: 'oklch(1 0 0 / 8%)' }}
      >
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'oklch(0.7 0.19 25)' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'oklch(0.82 0.16 85)' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'oklch(0.75 0.17 145)' }} />
        <span className="text-fd-muted-foreground ml-2">#eng-agents</span>
      </div>

      <div className="space-y-3 p-4">
        {visible.map((m, i) => (
          <div key={`${m.kind}-${i}`} className="msg-in">
            <div className="text-fd-muted-foreground text-xs">
              {m.who}
              {m.kind === 'status' && <span className="ml-2 opacity-60">(edited in place)</span>}
            </div>
            <div
              className="whitespace-pre-wrap"
              style={{
                color:
                  m.kind === 'user'
                    ? 'var(--color-fd-foreground)'
                    : m.kind === 'status'
                      ? 'var(--color-fd-muted-foreground)'
                      : 'oklch(0.86 0.13 65)',
              }}
            >
              {m.text}
            </div>
          </div>
        ))}
        {shown < SCRIPT.length && (
          <span className="terminal-cursor inline-block h-4 w-2 align-middle" style={{ background: 'oklch(0.78 0.16 60)' }} />
        )}
      </div>
    </div>
  )
}
