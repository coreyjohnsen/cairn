import { useMemo } from 'react'
import { qrModules, qrSvgPath } from '@shared/qr'

/** A QR code that stays sharp at any size. Always dark on light, whatever the theme: cameras need that contrast. */
export function QrCode({ text, size = 240, label }: { text: string; size?: number; label: string }) {
  const { path, size: n } = useMemo(() => qrSvgPath(qrModules(text)), [text])
  return (
    <svg className="qr" viewBox={`0 0 ${n} ${n}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#ffffff" />
      <path d={path} fill="#10151a" />
    </svg>
  )
}
