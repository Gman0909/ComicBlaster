// Plain CSS spinner — visible on any background, no external deps.

interface Props {
  size?: number       // diameter in px
  label?: string      // optional caption underneath
  className?: string  // extra classes (e.g. text color override)
}

export default function Spinner({ size = 36, label, className = '' }: Props) {
  return (
    <div className={`inline-flex flex-col items-center gap-3 ${className}`}>
      <div
        role="status"
        aria-label={label ?? 'Loading'}
        className="rounded-full border-2 border-current border-t-transparent animate-spin"
        style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 12)) }}
      />
      {label && <span className="text-sm">{label}</span>}
    </div>
  )
}

// Full-screen centered loading state used by route fallbacks.
export function FullPageSpinner({ label }: { label?: string }) {
  return (
    <div className="min-h-dvh w-full bg-black flex items-center justify-center">
      <Spinner size={48} label={label} className="text-white/80" />
    </div>
  )
}
