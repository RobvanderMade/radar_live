import { useEffect, useMemo, useState } from 'react'
import { onValue, ref } from 'firebase/database'
import { getRtdb } from './firebase'
import './App.css'

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
const WINDOW_TICK_MS = Number(
  import.meta.env.VITE_WINDOW_TICK_MS ?? 3000,
)

type RawRow = Record<string, unknown>

type Row = {
  key: string
  timestampMs: number | null
  value: RawRow
}

function readTsField(): string {
  return import.meta.env.VITE_RTDB_TS_FIELD?.trim() || 'timestamp'
}

function readPath(): string {
  const p = import.meta.env.VITE_RTDB_PATH?.trim()
  return p && p.length > 0 ? p : 'radar/peaks'
}

function toMillis(ts: unknown): number | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null
  if (ts > 1e12) return ts
  if (ts > 1e9) return ts * 1000
  return ts
}

/** `timestamp_peak` zoals "2026-05-08 22:24:06" — lokale wandtijd */
function parseTimestampPeakLocal(s: string): number | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, sec] = m
  const t = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    sec != null ? Number(sec) : 0,
  )
  return Number.isFinite(t.getTime()) ? t.getTime() : null
}

function extractTimestampMs(val: RawRow, tsField: string): number | null {
  if (typeof val.stored_at_utc === 'string') {
    const ms = Date.parse(val.stored_at_utc)
    if (Number.isFinite(ms)) return ms
  }
  if (typeof val.timestamp_peak === 'string') {
    const ms = parseTimestampPeakLocal(val.timestamp_peak)
    if (ms != null) return ms
  }
  const direct = toMillis(val[tsField])
  if (direct != null) return direct
  const alt =
    toMillis(val.createdAt) ??
    toMillis(val.ts) ??
    toMillis(val.time)
  return alt
}

function readSpeedKmh(val: RawRow): number | null {
  const v = val.peak_speed_kmh
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

function readDirection(val: RawRow): string | null {
  const v = val.direction
  if (typeof v === 'string') {
    const s = v.trim()
    return s.length > 0 ? s : null
  }
  return null
}

const dateFmtNl = new Intl.DateTimeFormat('nl-NL', { dateStyle: 'short' })
const timeFmtNl = new Intl.DateTimeFormat('nl-NL', { timeStyle: 'medium' })

function formatDate(ms: number): string {
  return dateFmtNl.format(new Date(ms))
}

function formatClock(ms: number): string {
  return timeFmtNl.format(new Date(ms))
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat('nl-NL', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(ms))
}

function PeaksTable({
  rows,
  emptyHint,
}: {
  rows: Row[]
  emptyHint?: string
}) {
  if (rows.length === 0) {
    return emptyHint ? <p className="muted empty">{emptyHint}</p> : null
  }
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Datum</th>
            <th>Tijd</th>
            <th>Richting</th>
            <th className="num">Snelheid</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ms = r.timestampMs
            const speed = readSpeedKmh(r.value)
            const direction = readDirection(r.value)
            return (
              <tr key={r.key}>
                <td>{ms != null ? formatDate(ms) : '—'}</td>
                <td>{ms != null ? formatClock(ms) : '—'}</td>
                <td>{direction ?? '—'}</td>
                <td className="num">
                  {speed != null
                    ? `${speed.toLocaleString('nl-NL')} km/h`
                    : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function App() {
  const path = readPath()
  const tsField = readTsField()

  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), WINDOW_TICK_MS)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let unsubConnected: (() => void) | undefined
    try {
      const db = getRtdb()
      const metaRef = ref(db, '.info/connected')
      unsubConnected = onValue(metaRef, (snap) => {
        setConnected(!!snap.val())
      })

      const dataRef = ref(db, path)
      const unsubData = onValue(
        dataRef,
        (snapshot) => {
          setError(null)
          setLoading(false)
          const next: Row[] = []
          snapshot.forEach((child) => {
            const value = (child.val() ?? {}) as RawRow
            next.push({
              key: child.key ?? '?',
              timestampMs: extractTimestampMs(value, tsField),
              value,
            })
          })
          setRows(next)
        },
        (err) => {
          setLoading(false)
          setError(err.message)
        },
      )

      return () => {
        unsubConnected?.()
        unsubData()
      }
    } catch (e) {
      setLoading(false)
      setError(e instanceof Error ? e.message : String(e))
      return () => {
        unsubConnected?.()
      }
    }
  }, [path, tsField])

  const cutoff = now - FOUR_HOURS_MS

  const { inWindow, stale } = useMemo(() => {
    const inWindow: Row[] = []
    const stale: Row[] = []
    for (const r of rows) {
      if (r.timestampMs == null) {
        stale.push(r)
        continue
      }
      if (r.timestampMs >= cutoff) inWindow.push(r)
      else stale.push(r)
    }
    inWindow.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0))
    return { inWindow, stale }
  }, [rows, cutoff])

  const staleSorted = useMemo(() => {
    return [...stale].sort((a, b) => {
      const ta = a.timestampMs ?? Number.NEGATIVE_INFINITY
      const tb = b.timestampMs ?? Number.NEGATIVE_INFINITY
      return tb - ta
    })
  }, [stale])

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>RTDB dashboard</h1>
          <p className="subtitle">
            Pad <code>{path}</code> · sortering op{' '}
            <code>stored_at_utc</code> / <code>timestamp_peak</code> /{' '}
            <code>{tsField}</code> · venster <strong>laatste 4 uur</strong> ·
            tick {WINDOW_TICK_MS / 1000}s
          </p>
        </div>
        <div className={`pill ${connected ? 'on' : 'off'}`}>
          {connected ? 'Verbonden' : 'Niet verbonden'}
        </div>
      </header>

      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}

      {loading && <p className="muted">Bezig met laden…</p>}

      <section className="panel">
        <div className="panel-head">
          <h2>
            Pieken in venster{' '}
            <span className="count">{inWindow.length}</span>
          </h2>
          <p className="muted small">
            Updates komen binnen via Firebase <code>onValue</code> (live). Het
            tijdsvenster schuift elke paar seconden mee.
          </p>
        </div>

        {!loading && (
          <PeaksTable
            rows={inWindow}
            emptyHint={`Geen pieken met bekende tijd ≥ ${formatTime(cutoff)}.`}
          />
        )}
      </section>

      {stale.length > 0 && (
        <section className="panel muted-panel">
          <h3>
            Buiten venster of zonder tijdstempel{' '}
            <span className="count">{stale.length}</span>
          </h3>
          <p className="muted small">
            Ouder dan 4 uur of zonder bruikbare tijd (<code>
              stored_at_utc
            </code>
            , <code>timestamp_peak</code> of <code>{tsField}</code>) — niet in
            hoofdtabel.
          </p>
          <PeaksTable rows={staleSorted.slice(0, 12)} />
          {stale.length > 12 && (
            <p className="muted small stale-more">
              … en {stale.length - 12} meer
            </p>
          )}
        </section>
      )}
    </div>
  )
}

export default App
