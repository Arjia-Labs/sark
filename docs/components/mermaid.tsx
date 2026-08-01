'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useTheme } from 'next-themes'

/**
 * Client-side mermaid renderer. Loaded dynamically so mermaid never lands in
 * the initial bundle, and re-rendered on theme change so diagrams match the
 * surrounding page in both light and dark.
 */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, '')
  const { resolvedTheme } = useTheme()
  const [svg, setSvg] = useState('')
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const { default: mermaid } = await import('mermaid')
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        fontFamily: 'var(--font-geist), sans-serif',
        theme: resolvedTheme === 'dark' ? 'dark' : 'default',
        themeVariables:
          resolvedTheme === 'dark'
            ? {
                primaryColor: '#2a1f16',
                primaryTextColor: '#ede8e2',
                primaryBorderColor: '#c8873f',
                lineColor: '#c8873f',
                secondaryColor: '#241b28',
                tertiaryColor: '#1a1512',
              }
            : {
                primaryColor: '#fdf3e7',
                primaryTextColor: '#2a2018',
                primaryBorderColor: '#c8873f',
                lineColor: '#a06a2c',
              },
      })
      const { svg } = await mermaid.render(`mermaid-${id}`, chart.trim())
      if (!cancelled) setSvg(svg)
    })()

    return () => {
      cancelled = true
    }
  }, [chart, id, resolvedTheme])

  return (
    <div
      ref={container}
      className="my-6 overflow-x-auto rounded-lg border p-4 text-center"
      style={{ borderColor: 'var(--color-fd-border)' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
