/** The Cairn mark: three balanced stones. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="Cairn" role="img">
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" style={{ stopColor: 'var(--accent)' }} />
          <stop offset="100%" style={{ stopColor: 'var(--accent-strong)' }} />
        </linearGradient>
      </defs>
      <ellipse cx="16" cy="26" rx="11.5" ry="4.6" fill="url(#logo-g)" opacity="0.95" />
      <ellipse cx="15.2" cy="18" rx="8" ry="3.9" fill="url(#logo-g)" opacity="0.8" />
      <ellipse cx="16.6" cy="11" rx="5" ry="3.1" fill="url(#logo-g)" opacity="0.62" />
      <ellipse cx="16" cy="5.6" rx="2.5" ry="2" fill="url(#logo-g)" opacity="0.48" />
    </svg>
  )
}
