import { useEffect, useState } from 'react'

// A small badge in the title bar while a new version is on its way: shows the download, and an "Install" button once it is ready.
// Renders nothing when there is no update (or in the browser, where there is nothing to update).
interface Status { state: string; pending?: string; pct?: number; waiting?: string; error?: string }
interface Api { updaterStatus(): Promise<Status>; updaterInstallNow(): Promise<boolean>; onUpdaterStatus(cb: (s: Status) => void): void }

export default function UpdateChip() {
  const api = ((window as unknown as { comms?: Api; sdi?: Api }).comms ?? (window as unknown as { sdi?: Api }).sdi) as Api | undefined
  const [s, setS] = useState<Status | null>(null)
  useEffect(() => {
    if (!api?.updaterStatus) return
    api.updaterStatus().then(setS).catch(() => {})
    api.onUpdaterStatus(setS)
  }, [api])
  if (!s || !s.pending || s.state === 'idle' || s.state === 'checking' || s.state === 'off') return null
  const label =
    s.state === 'downloading' ? `Updating to ${s.pending}… ${s.pct ?? 0}%` :
    s.state === 'installing' ? `Installing ${s.pending}…` :
    s.state === 'error' ? `Update ${s.pending} failed` :
    `Update ${s.pending} ready`
  const title = s.state === 'error' ? s.error : s.state === 'ready' && s.waiting ? `Installs automatically after: ${s.waiting}` : undefined
  return (
    <span className="update-chip" title={title}>
      <span>{label}</span>
      {s.state === 'ready' && <button onClick={() => { void api!.updaterInstallNow() }}>Install now</button>}
    </span>
  )
}
