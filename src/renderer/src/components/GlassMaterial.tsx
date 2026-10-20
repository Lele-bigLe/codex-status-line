/*
 * SVG refraction adapted from React Bits Glass Surface:
 * https://github.com/DavidHDev/react-bits
 *
 * MIT + Commons Clause License Condition v1.0
 * Copyright (c) 2026 David Haz
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, and distribute the Software as part of
 * an application, website, or product, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * Commons Clause Restriction
 * You may use this Software, including for any commercial purpose, so long as
 * you do not sell, sublicense, or redistribute the components themselves —
 * whether alone, in a bundle, or as a ported version.
 * The same restriction covers the React Bits tools (Background Studio, Texture
 * Lab, Shape Magic, Center Stage, Sound Lab and any tools added later) and the
 * sounds in the sound library. You may not sell, sublicense, or redistribute
 * the tools or the sounds themselves, or offer the tools or a substantially
 * similar copy of them as a hosted service — whether alone, in a bundle, or
 * as a ported version.
 * What you make with the tools is yours to use. You can use exported code,
 * images, videos, and audio files in any personal or commercial application,
 * website, or product, including paid ones. You may not sell or redistribute
 * the exports on their own, either individually or as the product itself,
 * such as a sound, texture, background, or template pack.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'

export function GlassMaterial({ radius = 20 }: { radius?: number }): React.JSX.Element {
  const id = `glass-${useId().replace(/[^\w-]/g, '')}`
  const root = useRef<HTMLSpanElement>(null)
  const [map, setMap] = useState<string>()

  useEffect(() => {
    const element = root.current
    // Electron 和 Windows WebView2 使用 Chromium；其他内核使用 CSS 磨砂材质。
    if (
      !element ||
      !/Chrome\//.test(navigator.userAgent) ||
      !CSS.supports('backdrop-filter', `url(#${id})`)
    )
      return
    const reduced = matchMedia('(prefers-reduced-transparency: reduce), (forced-colors: active)')
    let size = ''
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width)
      const height = Math.round(entry.contentRect.height)
      if (!width || !height || size === `${width}:${height}`) return
      size = `${width}:${height}`
      const edge = Math.min(7, Math.max(2, Math.min(width, height) * 0.06))
      const curve = Math.min(radius, width / 2, height / 2)
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <defs>
          <linearGradient id="x"><stop stop-color="red"/><stop offset="1" stop-color="black"/></linearGradient>
          <linearGradient id="y" x2="0" y2="1"><stop stop-color="lime"/><stop offset="1" stop-color="black"/></linearGradient>
          <filter id="soft"><feGaussianBlur stdDeviation="1.5"/></filter>
        </defs>
        <rect width="100%" height="100%" rx="${curve}" fill="url(#x)"/>
        <rect width="100%" height="100%" rx="${curve}" fill="url(#y)" style="mix-blend-mode:screen"/>
        <rect x="${edge}" y="${edge}" width="${Math.max(0, width - edge * 2)}" height="${Math.max(0, height - edge * 2)}" rx="${Math.max(0, curve - edge)}" fill="#808080" filter="url(#soft)"/>
      </svg>`
      setMap(`data:image/svg+xml,${encodeURIComponent(svg)}`)
    })
    const update = (): void => {
      observer.disconnect()
      size = ''
      if (reduced.matches) setMap(undefined)
      else observer.observe(element)
    }
    update()
    reduced.addEventListener('change', update)
    return () => {
      observer.disconnect()
      reduced.removeEventListener('change', update)
    }
  }, [id, radius])

  return (
    <span className="glass-material" ref={root} aria-hidden="true">
      {map ? (
        <svg className="glass-material__filter" width="0" height="0" focusable="false">
          <defs>
            <filter
              id={id}
              x="0%"
              y="0%"
              width="100%"
              height="100%"
              colorInterpolationFilters="sRGB"
            >
              <feImage
                href={map}
                x="0"
                y="0"
                width="100%"
                height="100%"
                preserveAspectRatio="none"
                result="map"
              />
              <feDisplacementMap
                in="SourceGraphic"
                in2="map"
                scale="22"
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
        </svg>
      ) : null}
      <span
        className={`glass-material__pane${map ? ' glass-material__pane--refractive' : ''}`}
        style={map ? ({ '--glass-filter': `url(#${id})` } as CSSProperties) : undefined}
      />
    </span>
  )
}
