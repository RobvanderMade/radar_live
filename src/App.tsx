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
  return import.meta.env.VITE_RTDB_TS_FIELD?.trim() || 'ts'
}

function readPath(): string {
  const p = import.meta.env.VITE_RTDB_PATH?.trim()
  return p && p.length > 0 ? p : 'ld2451/scanner/events'
}

function toMillis(ts: unknown): number | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null
  if (ts > 1e12) return ts
  if (ts > 1e9) return ts * 1000
  return ts
}

/** LD2451: `datum` "2026-05-14" + `tijd` "15:01:12.332" — lokale tijd */
function parseDatumTijdLocal(datum: string, tijd: string): number | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datum.trim())
  const tm = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(tijd.trim())
  if (!dm || !tm) return null
  const [, y, mo, d] = dm
  const [, h, mi, sec, frac] = tm
  const ms = frac != null ? Number(String(frac).padEnd(3, '0').slice(0, 3)) : 0
  const t = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(sec),
    ms,
  )
  return Number.isFinite(t.getTime()) ? t.getTime() : null
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

function parseIsoTimestamp(s: string): number | null {
  const ms = Date.parse(s.trim())
  return Number.isFinite(ms) ? ms : null
}

function extractTimestampMs(val: RawRow, tsField: string): number | null {
  const configured = val[tsField]
  if (typeof configured === 'string') {
    const ms = parseIsoTimestamp(configured)
    if (ms != null) return ms
  }
  if (typeof val.ts === 'string') {
    const ms = parseIsoTimestamp(val.ts)
    if (ms != null) return ms
  }
  const direct = toMillis(configured)
  if (direct != null) return direct
  if (typeof val.stored_at_utc === 'string') {
    const ms = parseIsoTimestamp(val.stored_at_utc)
    if (ms != null) return ms
  }
  if (typeof val.datum === 'string' && typeof val.tijd === 'string') {
    const ms = parseDatumTijdLocal(val.datum, val.tijd)
    if (ms != null) return ms
  }
  if (typeof val.timestamp_peak === 'string') {
    const ms = parseTimestampPeakLocal(val.timestamp_peak)
    if (ms != null) return ms
  }
  const alt =
    toMillis(val.createdAt) ??
    toMillis(val.ts) ??
    toMillis(val.time)
  return alt
}

function readSpeedKmh(val: RawRow): number | null {
  const v = val.speed_kmh ?? val.snelheid_kmh ?? val.peak_speed_kmh
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

function readDirection(val: RawRow): string | null {
  const v = val.direction ?? val.richting
  if (typeof v === 'string') {
    const s = v.trim()
    return s.length > 0 ? s : null
  }
  return null
}

/** Maximumsnelheid ter plaatse (km/h) */
const SPEED_LIMIT_KMH = 30

/** Correctie op meting vóór overschrijding (km/h) */
const SPEED_MEASUREMENT_CORRECTION_KMH = 3

/** Tot en met deze gemeten snelheid: geen boete */
const FINE_FREE_UP_TO_KMH = 36

const FINE_EUR_BY_OVERSPEED: Record<number, number> = {
  4: 62,
  5: 73,
  6: 85,
  7: 98,
  8: 113,
  9: 126,
  10: 142,
  11: 179,
  12: 194,
  13: 210,
  14: 229,
  15: 246,
  16: 263,
  17: 282,
  18: 301,
  19: 321,
  20: 342,
  21: 363,
  22: 388,
  23: 410,
  24: 434,
  25: 456,
  26: 481,
  27: 505,
  28: 524,
  29: 524,
  30: 545,
}

const FINE_EUR_BY_OVERSPEED_RANGE: { min: number; max: number; amount: number }[] =
  [
    { min: 31, max: 35, amount: 580 },
    { min: 36, max: 40, amount: 720 },
    { min: 41, max: 45, amount: 840 },
    { min: 46, max: 50, amount: 1000 },
    { min: 51, max: 55, amount: 1150 },
    { min: 56, max: 60, amount: 1350 },
    { min: 61, max: 65, amount: 1550 },
    { min: 66, max: 70, amount: 1700 },
    { min: 71, max: 75, amount: 1950 },
    { min: 76, max: 80, amount: 2150 },
    { min: 81, max: 85, amount: 2400 },
    { min: 86, max: 90, amount: 2600 },
    { min: 91, max: 95, amount: 2900 },
    { min: 96, max: 100, amount: 3350 },
  ]

function overspeedKmh(speedKmh: number): number {
  return (
    Math.round(speedKmh) -
    SPEED_LIMIT_KMH -
    SPEED_MEASUREMENT_CORRECTION_KMH
  )
}

function fineEurForOverspeed(overspeed: number): number {
  if (overspeed < 4) return 0
  const exact = FINE_EUR_BY_OVERSPEED[overspeed]
  if (exact != null) return exact
  for (const band of FINE_EUR_BY_OVERSPEED_RANGE) {
    if (overspeed >= band.min && overspeed <= band.max) return band.amount
  }
  if (overspeed > 100) {
    return FINE_EUR_BY_OVERSPEED_RANGE.at(-1)?.amount ?? 3350
  }
  return 0
}

function fineEurForSpeedKmh(speedKmh: number): number {
  const speed = Math.round(speedKmh)
  if (speed <= FINE_FREE_UP_TO_KMH) return 0
  return fineEurForOverspeed(overspeedKmh(speed))
}

function formatFineEur(amount: number): string {
  return `€ ${amount.toLocaleString('nl-NL')}`
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

function toMonthKey(ms: number): string {
  const dt = new Date(ms)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function sumFineEur(rows: Row[], match?: { dayKey?: string; monthKey?: string }): number {
  let sum = 0
  for (const r of rows) {
    if (r.timestampMs == null) continue
    if (match?.dayKey != null && toDayKey(r.timestampMs) !== match.dayKey) continue
    if (match?.monthKey != null && toMonthKey(r.timestampMs) !== match.monthKey) {
      continue
    }
    const speed = readSpeedKmh(r.value)
    if (speed == null) continue
    sum += fineEurForSpeedKmh(speed)
  }
  return sum
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

const INFO_PARAGRAPHS = [
  'Geestweg Live toont snelheidsmetingen van het verkeer op de Geestweg in Naaldwijk. Nieuwe passages vanaf een gemeten snelheid van 35 km/u verschijnen live.',
  'In de tabel zie je per meting datum, tijd, snelheid, richting en een indicatief boetebedrag. Sorteer op tijd of snelheid en kies via “Andere dag” een andere kalenderdag.',
  'Het record van de dag is de hoogste gemeten snelheid op de geselecteerde dag. Het record aller tijden is het maximum over alle geladen metingen.',
  'Boetebedragen zijn een rekenvoorbeeld en gebaseerd op de boetes 2026 voor een 30 km-weg. Een correctie van 3 km en een drempel van 4 km is de norm zodat boetes vanaf 37 km/u worden berekend.',
  '“Boetebedrag van de dag” en “Boetebedrag deze maand” tellen de indicatieve bedragen op voor de geselecteerde dag respectievelijk de lopende kalendermaand.',
  'De status “Verbonden” betekent dat de app live verbonden is met de radar en nieuwe events ontvangt. Bij “Niet verbonden” worden geen nieuwe events ontvangen.',
  'De metingen en resultaten zijn slechts indicatief en zonder verdere gevolgen of juridische onderbouwing.',
]

function InfoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="info-backdrop" onClick={onClose}>
      <div
        className="info-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="info-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="info-dialog-head">
          <h2 id="info-dialog-title">Informatie</h2>
          <button
            type="button"
            className="info-close"
            onClick={onClose}
            aria-label="Sluiten"
          >
            ×
          </button>
        </div>
        <div className="info-dialog-body">
          {INFO_PARAGRAPHS.map((text) => (
            <p key={text}>{text}</p>
          ))}
        </div>
      </div>
    </div>
  )
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
            <th className="num">Snelheid</th>
            <th>Richting</th>
            <th className="num">Boetebedrag</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ms = r.timestampMs
            const speed = readSpeedKmh(r.value)
            const direction = readDirection(r.value)
            const fineEur = speed != null ? fineEurForSpeedKmh(speed) : null
            return (
              <tr key={r.key}>
                <td>{ms != null ? formatDate(ms) : '—'}</td>
                <td>{ms != null ? formatClock(ms) : '—'}</td>
                <td className="num">
                  {speed != null
                    ? `${speed.toLocaleString('nl-NL')} km/h`
                    : '—'}
                </td>
                <td>{direction ?? '—'}</td>
                <td className="num">
                  {fineEur != null ? formatFineEur(fineEur) : '—'}
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
  const [infoOpen, setInfoOpen] = useState(false)

  useEffect(() => {
    const tickMs = Math.min(1000, WINDOW_TICK_MS)
    const id = window.setInterval(() => setNow(Date.now()), tickMs)
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

  const speedRecordSelectedDay = useMemo(() => {
    let max: number | null = null
    for (const r of rowsWithTimestamp) {
      if (r.timestampMs == null || toDayKey(r.timestampMs) !== selectedDay) {
        continue
      }
      const speed = readSpeedKmh(r.value)
      if (speed == null) continue
      if (max == null || speed > max) max = speed
    }
    return max
  }, [rowsWithTimestamp, selectedDay])

  const speedRecordAllTime = useMemo(() => {
    let max: number | null = null
    for (const r of rowsWithTimestamp) {
      const speed = readSpeedKmh(r.value)
      if (speed == null) continue
      if (max == null || speed > max) max = speed
    }
    return max
  }, [rowsWithTimestamp])

  const totalFineSelectedDay = useMemo(
    () => sumFineEur(rowsWithTimestamp, { dayKey: selectedDay }),
    [rowsWithTimestamp, selectedDay],
  )

  const totalFineThisMonth = useMemo(
    () => sumFineEur(rowsWithTimestamp, { monthKey: toMonthKey(now) }),
    [rowsWithTimestamp, now],
  )

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
            <h1>Geestweg Live</h1>
            <p className="brand-tagline">Realtime snelheidsmonitor</p>
          </div>
        </div>
        <div className="header-meta">
          <button
            type="button"
            className="info-btn"
            onClick={() => setInfoOpen(true)}
            aria-label="Informatie openen"
            title="Informatie"
          >
            info
          </button>
          <time className="header-clock" dateTime={new Date(now).toISOString()}>
            {formatClock(now)}
          </time>
          <div className={`pill ${connected ? 'on' : 'off'}`}>
            {connected ? 'Verbonden' : 'Niet verbonden'}
          </div>
        </div>
      </header>

      <InfoDialog open={infoOpen} onClose={() => setInfoOpen(false)} />

      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div className="banner info" role="status">
          Er komen geen events binnen op RTDB-pad <code>{path}</code>. Lokaal
          staat dat in <code>VITE_RTDB_PATH</code>; op Vercel moet dezelfde
          waarde in de build staan (variabele zetten en opnieuw deployen).
        </div>
      )}

      {!loading &&
        !error &&
        rows.length > 0 &&
        sortedRowsInSelectedDay.length === 0 && (
          <div className="banner info" role="status">
            Er zijn {rows.length} event(s) geladen, maar geen op{' '}
            {selectedDay === todayKey
              ? `vandaag (${formatDate(now)})`
              : formatDayLabel(selectedDay)}{' '}
            met een bruikbare tijd. Probeer <strong>Andere dag</strong>, of
            kijk hieronder bij <strong>Zonder bruikbare tijdstempel</strong>.
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
                metingen boven 35 km/u
              </>
            )}
          </h2>
          <div className="stats-grid" role="group" aria-label="Statistieken">
            <div className="stat-card">
              <span className="stat-label">Record van de dag</span>
              <span className="stat-value">
                {speedRecordSelectedDay != null
                  ? `${speedRecordSelectedDay.toLocaleString('nl-NL')} km/u`
                  : '—'}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Record aller tijden</span>
              <span className="stat-value">
                {speedRecordAllTime != null
                  ? `${speedRecordAllTime.toLocaleString('nl-NL')} km/u`
                  : '—'}
              </span>
            </div>
            <div className="stat-card stat-card--fine">
              <span className="stat-label">Boetebedrag van de dag</span>
              <span className="stat-value">
                {formatFineEur(totalFineSelectedDay)}
              </span>
            </div>
            <div className="stat-card stat-card--fine">
              <span className="stat-label">Boetebedrag deze maand</span>
              <span className="stat-value">
                {formatFineEur(totalFineThisMonth)}
              </span>
            </div>
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
            Deze records missen een bruikbare tijd (bijv.{' '}
            <code>ts</code> ISO, <code>datum</code>+<code>tijd</code>,{' '}
            <code>stored_at_utc</code>, <code>timestamp_peak</code> of{' '}
            <code>{tsField}</code>) en kunnen daarom niet op dag gefilterd
            worden.
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
