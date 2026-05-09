import { useEffect, useMemo, useState } from 'react'
import { onValue, ref } from 'firebase/database'
import { getRtdb } from './firebase'
import './App.css'

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

function toDayKey(ms: number): string {
  const dt = new Date(ms)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const d = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatDayLabel(dayKey: string): string {
  const dt = new Date(`${dayKey}T00:00:00`)
  return new Intl.DateTimeFormat('nl-NL', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(dt)
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
  const [sortBy, setSortBy] = useState<'time' | 'speed'>('time')

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

  const todayKey = toDayKey(now)

  const [selectedDay, setSelectedDay] = useState<string>(todayKey)

  const { rowsWithTimestamp, rowsWithoutTimestamp, availableDays } = useMemo(() => {
    const rowsWithTimestamp: Row[] = []
    const rowsWithoutTimestamp: Row[] = []
    const daySet = new Set<string>()
    for (const r of rows) {
      if (r.timestampMs == null) {
        rowsWithoutTimestamp.push(r)
        continue
      }
      rowsWithTimestamp.push(r)
      daySet.add(toDayKey(r.timestampMs))
    }
    rowsWithTimestamp.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0))
    rowsWithoutTimestamp.sort((a, b) => a.key.localeCompare(b.key))
    const availableDays = [...daySet].sort((a, b) => b.localeCompare(a))
    return { rowsWithTimestamp, rowsWithoutTimestamp, availableDays }
  }, [rows])

  useEffect(() => {
    if (selectedDay === todayKey) return
    if (!availableDays.includes(selectedDay)) {
      setSelectedDay(todayKey)
    }
  }, [availableDays, selectedDay, todayKey])

  const rowsInSelectedDay = useMemo(() => {
    return rowsWithTimestamp.filter((r) => {
      if (r.timestampMs == null) return false
      return toDayKey(r.timestampMs) === selectedDay
    })
  }, [rowsWithTimestamp, selectedDay])

  const sortedRowsInSelectedDay = useMemo(() => {
    const next = [...rowsInSelectedDay]
    if (sortBy === 'speed') {
      next.sort((a, b) => {
        const sa = readSpeedKmh(a.value) ?? Number.NEGATIVE_INFINITY
        const sb = readSpeedKmh(b.value) ?? Number.NEGATIVE_INFINITY
        if (sb !== sa) return sb - sa
        return (b.timestampMs ?? 0) - (a.timestampMs ?? 0)
      })
      return next
    }
    next.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0))
    return next
  }, [rowsInSelectedDay, sortBy])

  const otherDays = useMemo(
    () => availableDays.filter((d) => d !== todayKey),
    [availableDays, todayKey],
  )

  const speedRecordToday = useMemo(() => {
    let max: number | null = null
    for (const r of rowsWithTimestamp) {
      if (r.timestampMs == null || toDayKey(r.timestampMs) !== todayKey) continue
      const speed = readSpeedKmh(r.value)
      if (speed == null) continue
      if (max == null || speed > max) max = speed
    }
    return max
  }, [rowsWithTimestamp, todayKey])

  const speedRecordAllTime = useMemo(() => {
    let max: number | null = null
    for (const r of rowsWithTimestamp) {
      const speed = readSpeedKmh(r.value)
      if (speed == null) continue
      if (max == null || speed > max) max = speed
    }
    return max
  }, [rowsWithTimestamp])

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="radar-logo" aria-hidden="true">
            <span className="radar-ring ring-1" />
            <span className="radar-ring ring-2" />
            <span className="radar-dot" />
            <span className="radar-beam" />
          </div>
          <div>
            <h1>Radar Live</h1>
            <p className="brand-tagline">Realtime snelheidsmonitor</p>
          </div>
        </div>
        <div className="header-meta">
          <div className={`pill ${connected ? 'on' : 'off'}`}>
            {connected ? 'Verbonden' : 'Niet verbonden'}
          </div>
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
            {selectedDay === todayKey ? (
              <>
                Vandaag ({formatDate(now)}) ·{' '}
                <span className="count">{sortedRowsInSelectedDay.length}</span>{' '}
                metingen boven 35 km/u
              </>
            ) : (
              <>
                {formatDayLabel(selectedDay)} ·{' '}
                <span className="count">{sortedRowsInSelectedDay.length}</span>{' '}
                metingen boven 30 km/u
              </>
            )}
          </h2>
          <div className="records">
            <p className="record-pill">
              Snelheidsrecord vandaag:{' '}
              <strong>
                {speedRecordToday != null
                  ? `${speedRecordToday.toLocaleString('nl-NL')} km/u`
                  : '—'}
              </strong>
            </p>
            <p className="record-pill">
              Snelheidsrecord aller tijden:{' '}
              <strong>
                {speedRecordAllTime != null
                  ? `${speedRecordAllTime.toLocaleString('nl-NL')} km/u`
                  : '—'}
              </strong>
            </p>
          </div>
          <div className="day-filter">
            <label htmlFor="day-select">Andere dag</label>
            <select
              id="day-select"
              value={selectedDay}
              onChange={(e) => setSelectedDay(e.target.value)}
            >
              <option value={todayKey}>Vandaag ({formatDate(now)})</option>
              {otherDays.map((day) => (
                <option key={day} value={day}>
                  {formatDayLabel(day)}
                </option>
              ))}
            </select>
            <label htmlFor="sort-select">Sorteer op</label>
            <select
              id="sort-select"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'time' | 'speed')}
            >
              <option value="time">Tijd (nieuwste eerst)</option>
              <option value="speed">Snelheid (hoogste eerst)</option>
            </select>
          </div>
        </div>

        {!loading && (
          <PeaksTable
            rows={sortedRowsInSelectedDay}
            emptyHint={`Geen pieken met bekende tijd op ${
              selectedDay === todayKey
                ? `vandaag (${formatDate(now)})`
                : formatDayLabel(selectedDay)
            }.`}
          />
        )}
      </section>

      {rowsWithoutTimestamp.length > 0 && (
        <section className="panel muted-panel">
          <h3>
            Zonder bruikbare tijdstempel{' '}
            <span className="count">{rowsWithoutTimestamp.length}</span>
          </h3>
          <p className="muted small">
            Deze records missen <code>stored_at_utc</code>,{' '}
            <code>timestamp_peak</code> en <code>{tsField}</code>, en kunnen
            daarom niet op dag gefilterd worden.
          </p>
          <PeaksTable rows={rowsWithoutTimestamp.slice(0, 12)} />
          {rowsWithoutTimestamp.length > 12 && (
            <p className="muted small stale-more">
              … en {rowsWithoutTimestamp.length - 12} meer
            </p>
          )}
        </section>
      )}
    </div>
  )
}

export default App
