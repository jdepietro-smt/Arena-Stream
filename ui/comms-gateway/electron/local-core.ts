// Pure helpers for the local fallback server (no Electron imports, so they can be tested with plain Node).

/** The http(s) address of a Comms server's admin API, from whatever the gateway has configured for the main server:
 *  "5.161.235.143" -> https://5.161.235.143/comms, "wss://host/comms" -> https://host/comms, "ws://10.0.0.5:8900" -> http://10.0.0.5:8900 */
export function primaryHttpBase(server: string): string {
  const t = String(server ?? '').trim().replace(/\/+$/, '')
  if (!t) return ''
  if (/^wss?:\/\//i.test(t)) return t.replace(/^ws(s?):\/\//i, (_m, s: string) => (s ? 'https://' : 'http://'))
  return `https://${t}/comms`
}

export interface LocalServerCfg { enabled: boolean; port: number; username: string; password: string; primary: string }

/** The environment the local server is started with: a LAN-only standby (mesh audio, no media relay) of the main server. */
export function localServerEnv(cfg: LocalServerCfg, dataFile: string): Record<string, string> {
  return {
    COMMS_PORT: String(cfg.port),
    COMMS_HOST: '0.0.0.0',                 // reachable by other computers in the venue
    COMMS_DATA: dataFile,
    COMMS_AUTH: 'accounts',
    COMMS_ICE: '[]',                       // no internet: local network addresses are enough
    COMMS_STANDBY_URL: primaryHttpBase(cfg.primary),
    COMMS_STANDBY_USER: cfg.username,
    COMMS_STANDBY_PASSWORD: cfg.password,
    NODE_OPTIONS: '--use-system-ca',       // trust the same certificates Windows does (the main server's certificate)
  }
}

export function validLocalCfg(c: Partial<LocalServerCfg> | null | undefined): string {
  if (!c) return 'Not set up'
  if (!Number.isInteger(c.port) || (c.port as number) < 1024 || (c.port as number) > 65535) return 'The port must be a number from 1024 to 65535'
  if (!primaryHttpBase(c.primary ?? '')) return 'Set the main server address first (Intercom server, above)'
  if (!c.username || !c.password) return 'Enter the administrator account the copy is made with'
  return ''
}
