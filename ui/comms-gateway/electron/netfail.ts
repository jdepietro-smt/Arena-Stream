// Backup internet line: lets the page prefer one network adapter over another by changing Windows' interface metrics.
// Windows sends traffic out of the adapter with the lowest metric, so giving the backup adapter the lowest one moves new
// connections onto it. Changing metrics needs administrator rights; every call reports that plainly instead of failing quietly.
import { app, ipcMain } from 'electron'
import { execFile, spawnSync } from 'child_process'

interface Adapter { alias: string; description: string; speed: string; metric: number; auto: boolean; gateway: boolean }
type NetResult = { ok: true } | { ok: false; error: string; needsAdmin?: boolean }

function ps(script: string, env: Record<string, string> = {}): Promise<{ out: string; err: string; code: number }> {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 20000 },
      (e, out, err) => resolve({ out: String(out), err: String(err || e?.message || ''), code: e ? ((e as { code?: number }).code ?? 1) : 0 }))
  })
}

const isAdmin = async () =>
  (await ps('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)')).out.trim() === 'True'

/** Connected IPv4 adapters, with their current metric and whether they have a default gateway (a way out). */
async function adapters(): Promise<Adapter[]> {
  const r = await ps(`
    $gw = @{}; Get-NetRoute -DestinationPrefix 0.0.0.0/0 -ErrorAction SilentlyContinue | ForEach-Object { $gw[$_.InterfaceAlias] = $true }
    Get-NetIPInterface -AddressFamily IPv4 -ConnectionState Connected -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' } | ForEach-Object {
      $a = Get-NetAdapter -InterfaceAlias $_.InterfaceAlias -ErrorAction SilentlyContinue
      [pscustomobject]@{ alias = $_.InterfaceAlias; description = "$($a.InterfaceDescription)"; speed = "$($a.LinkSpeed)"; metric = [int]$_.InterfaceMetric; auto = ($_.AutomaticMetric -eq 'Enabled'); gateway = [bool]$gw[$_.InterfaceAlias] }
    } | ConvertTo-Json -Compress`)
  try {
    const j = JSON.parse(r.out.trim() || '[]')
    return (Array.isArray(j) ? j : [j]) as Adapter[]
  } catch { return [] }
}

/** Prefer `alias` (lowest metric), push the other connected adapters behind it. null puts every adapter back on automatic metrics. */
async function prefer(alias: string | null): Promise<NetResult> {
  const script = alias === null
    ? `Get-NetIPInterface -AddressFamily IPv4 | ForEach-Object { Set-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AutomaticMetric Enabled -ErrorAction Stop }`
    : `$want = $env:GW_ALIAS
       $all = Get-NetIPInterface -AddressFamily IPv4 -ConnectionState Connected | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' }
       if (-not ($all | Where-Object InterfaceAlias -eq $want)) { throw "Adapter '$want' is not connected." }
       foreach ($i in $all) {
         $m = if ($i.InterfaceAlias -eq $want) { 5 } else { 500 }
         Set-NetIPInterface -InterfaceIndex $i.InterfaceIndex -AutomaticMetric Disabled -InterfaceMetric $m -ErrorAction Stop
       }`
  const r = await ps(script, { GW_ALIAS: alias ?? '' })
  if (r.code === 0 && !r.err.trim()) return { ok: true }
  const needsAdmin = /denied|administrator|privilege|0x80041003|PermissionDenied/i.test(r.err)
  return { ok: false, needsAdmin, error: needsAdmin ? 'Windows needs administrator rights to switch connections.' : (r.err.split('\n').find(l => l.trim()) ?? 'Could not change the network settings').trim() }
}

let changed = false
export function registerNetFail() {
  ipcMain.handle('net:info', async () => ({ admin: await isAdmin(), adapters: await adapters() }))
  ipcMain.handle('net:prefer', async (_e, alias: string | null) => {
    const r = await prefer(alias)
    if (r.ok) changed = alias !== null
    return r
  })
  // Start again with the same program but with administrator rights (Windows asks the user to approve).
  ipcMain.handle('app:relaunchAdmin', async () => {
    const exe = process.execPath.replace(/'/g, "''")
    app.releaseSingleInstanceLock() // the new copy must be allowed to start while this one is still closing
    const r = await ps(`Start-Process -FilePath '${exe}' -Verb RunAs`)
    if (r.code !== 0) { app.requestSingleInstanceLock(); return { ok: false, error: 'Administrator approval was not given.' } }
    app.exit(0)
    return { ok: true }
  })
  // Leave the PC's network the way it was found.
  app.on('before-quit', () => {
    if (changed) spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetIPInterface -AddressFamily IPv4 | ForEach-Object { Set-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AutomaticMetric Enabled }'], { windowsHide: true, timeout: 8000 })
  })
}
