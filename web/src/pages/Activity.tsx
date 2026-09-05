import { useEffect, useState } from 'react';
import { api, type ActivityDetail, type ActivityRow, type AttemptDetail } from '../api';
import { ModelName } from '../ui';

/**
 * Historial de peticiones.
 *
 * Cada fila dice qué API key llamó, qué modelo acabó atendiendo y a qué velocidad fue
 * esa petición concreta. Al pinchar se despliega el prompt, la respuesta y la cronología
 * de intentos, que es lo que permite entender por qué una petición salió como salió sin
 * tener que reproducirla.
 */
export function Activity({ rows }: { rows: ActivityRow[] }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [logContent, setLogContent] = useState(true);
  const [measureTtft, setMeasureTtft] = useState(true);

  useEffect(() => {
    api
      .loggingSettings()
      .then((settings) => setLogContent(settings.logContent))
      .catch(() => undefined);
    api
      .measurementSettings()
      .then((settings) => setMeasureTtft(settings.measureTtft))
      .catch(() => undefined);
  }, []);

  function toggleRow(row: ActivityRow) {
    if (openId === row.id) {
      setOpenId(null);
      return;
    }
    setOpenId(row.id);
    setDetail(null);
    // Se pide siempre, no solo si hay contenido: la cronología de intentos son métricas
    // y sigue estando ahí aunque el registro de prompts esté apagado.
    setLoading(true);
    api
      .activityDetail(row.id)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }

  if (rows.length === 0) {
    return <div className="notice">Aún no ha pasado ninguna petición por el router.</div>;
  }

  return (
    <div className="stack">
      <div className="row spread wrap">
        <span className="dim">
          Se conservan las últimas 500 peticiones. Pincha una fila para ver la cronología y el contenido.
        </span>
        <div className="row">
          <label
            className={`check ${measureTtft ? 'on' : ''}`}
            title="Pide streaming a los proveedores aunque tu cliente no lo pida, para poder cronometrar el primer token. La respuesta que recibes es la misma."
          >
            <input
              type="checkbox"
              checked={measureTtft}
              onChange={(event) => {
                const next = event.target.checked;
                setMeasureTtft(next);
                void api.setMeasurement(next);
              }}
              style={{ display: 'none' }}
            />
            Medir TTFT siempre
          </label>
          <label className={`check ${logContent ? 'on' : ''}`} title="Prompts y respuestas quedan guardados en la base de datos local">
            <input
              type="checkbox"
              checked={logContent}
              onChange={(event) => {
                const next = event.target.checked;
                setLogContent(next);
                void api.setLogging(next);
              }}
              style={{ display: 'none' }}
            />
            Guardar prompts y respuestas
          </label>
          <button
            className="danger"
            title="Borra los textos guardados, conservando las métricas"
            onClick={() => {
              void api.clearActivityContent().then(() => {
                setDetail(null);
                setOpenId(null);
              });
            }}
          >
            Purgar contenido
          </button>
        </div>
      </div>

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Hora</th>
              <th>API key</th>
              <th>Perfil</th>
              <th>Modelo elegido</th>
              <th>TTFT</th>
              <th>Total</th>
              <th>tok/s</th>
              <th>Tokens</th>
              <th>Int.</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <RowPair
                key={row.id}
                row={row}
                open={openId === row.id}
                detail={openId === row.id ? detail : null}
                loading={openId === row.id && loading}
                onToggle={() => toggleRow(row)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowPair({
  row,
  open,
  detail,
  loading,
  onToggle,
}: {
  row: ActivityRow;
  open: boolean;
  detail: ActivityDetail | null;
  loading: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer' }} title="Ver prompt y respuesta">
        <td>
          <span className="dim">{open ? '▾ ' : '▸ '}</span>
          {new Date(row.ts).toLocaleTimeString()}
        </td>
        <td>{row.api_key_name ?? <span className="dim">—</span>}</td>
        <td>{row.profile ?? '—'}</td>
        <td>
          {row.model_id && row.provider_id ? (
            <ModelName providerId={row.provider_id} modelId={row.model_id} />
          ) : (
            <span className="dim">—</span>
          )}
        </td>
        <td
          title={
            row.ttft_ms === null
              ? 'Sin dato: la respuesta llegó de una pieza. Actívalo con «Medir TTFT siempre».'
              : undefined
          }
        >
          {row.ttft_ms === null ? <span className="dim">—</span> : `${Math.round(row.ttft_ms)} ms`}
        </td>
        <td>{row.total_ms === null ? <span className="dim">—</span> : duration(row.total_ms)}</td>
        <td>{row.tps === null ? <span className="dim">—</span> : `${Math.round(row.tps)}`}</td>
        <td>
          {row.tokens_in === null && row.tokens_out === null ? '—' : `${row.tokens_in ?? 0} → ${row.tokens_out ?? 0}`}
        </td>
        <td>{row.attempts}</td>
        <td>{row.ok ? <span className="pill ok">ok</span> : <span className="pill bad">{row.error_kind}</span>}</td>
      </tr>
      {open && (
        <tr>
          {/*
            Las celdas de la tabla son `nowrap` para que las columnas se lean de un
            vistazo, pero aquí dentro va texto largo —mensajes de error de proveedor,
            prompts— y heredarlo estiraba la tabla entera hasta sacar las columnas de
            la pantalla. Dentro del desplegable se escribe en varias líneas.
          */}
          <td colSpan={10} style={{ background: 'var(--surface-2)', whiteSpace: 'normal', padding: 0 }}>
            {/*
              El contenido se ancla a la izquierda y se limita al ancho visible. Si la
              tabla llega a desbordar —una ventana estrecha, un nombre largo—, el
              desplegable seguiría siendo tan ancho como ella y su texto envolvería
              fuera de la pantalla, que es justo lo que se quería evitar.
            */}
            <div
              style={{
                position: 'sticky',
                left: 0,
                maxWidth: 'min(100%, calc(100vw - 80px), 1040px)',
                padding: '8px 10px',
              }}
            >
            {loading ? (
              <span className="dim">Cargando…</span>
            ) : (
              <div className="stack" style={{ padding: '4px 0' }}>
                <Timeline attempts={detail?.timeline ?? []} routerMs={detail?.routerMs ?? null} />
                {row.has_content ? (
                  <>
                    <Block title="Prompt" text={detail?.prompt} />
                    <Block title="Respuesta" text={detail?.response} />
                  </>
                ) : (
                  <span className="dim">
                    Esta petición no tiene contenido guardado (el registro estaba desactivado o se purgó).
                  </span>
                )}
              </div>
            )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** `420 ms` para lo corto, `2,1 s` para lo largo: en segundos, 2100 ms no se lee solo. */
function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

/**
 * Cronología de la petición.
 *
 * Es lo que explica un TTFT alto: si antes del modelo que respondió hubo dos que
 * fallaron, ese tiempo no aparece en ninguna otra columna del historial y la petición
 * parece lenta sin motivo.
 */
function Timeline({ attempts, routerMs }: { attempts: AttemptDetail[]; routerMs: number | null }) {
  if (attempts.length === 0) {
    return (
      <div>
        <div className="dim" style={{ marginBottom: 4 }}>
          Intentos
        </div>
        <span className="dim">
          Sin cronología: no se llegó a intentar ningún modelo, o la petición es anterior a esta función.
        </span>
      </div>
    );
  }

  const wasted = attempts.filter((attempt) => !attempt.ok).reduce((total, attempt) => total + attempt.ms, 0);
  const winner = attempts.find((attempt) => attempt.ok);

  return (
    <div>
      <div className="row spread wrap" style={{ marginBottom: 4 }}>
        <span className="dim">Intentos</span>
        <span className="dim">
          {routerMs !== null && (
            <span title="Tiempo dentro de FreeRouter: elegir candidatos y montar la respuesta. Todo lo demás es espera a los proveedores.">
              router {routerMs < 1 ? '<1 ms' : duration(routerMs)}
            </span>
          )}
          {wasted > 0 && (
            <>
              {routerMs !== null && ' · '}
              {duration(wasted)} {winner ? 'perdidos antes de acertar' : 'gastados sin respuesta'}
            </>
          )}
        </span>
      </div>
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--surface)',
          overflow: 'hidden',
        }}
      >
        {attempts.map((attempt, index) => (
          <div
            key={`${attempt.providerId}/${attempt.modelId}/${index}`}
            className="row"
            style={{
              gap: 10,
              padding: '7px 10px',
              borderTop: index === 0 ? 'none' : '1px solid var(--border)',
              alignItems: 'baseline',
            }}
          >
            <span className="dim mono" style={{ minWidth: 18 }}>
              {index + 1}
            </span>
            <span className={`pill ${attempt.ok ? 'ok' : 'bad'}`}>{attempt.ok ? 'ok' : attempt.errorKind ?? 'error'}</span>
            <span style={{ flex: 1, minWidth: 160, overflowWrap: 'anywhere' }}>
              <ModelName providerId={attempt.providerId} modelId={attempt.modelId} />
            </span>
            <span className="mono dim" style={{ whiteSpace: 'nowrap' }}>
              {attempt.ok && attempt.ttftMs !== null ? `TTFT ${duration(attempt.ttftMs)} · ` : ''}
              {duration(attempt.ms)}
            </span>
          </div>
        ))}
      </div>
      {attempts
        .filter((attempt) => !attempt.ok && attempt.message)
        .map((attempt, index) => (
          <div key={index} style={{ marginTop: 6 }}>
            <div className="dim" style={{ fontSize: 12, marginBottom: 2 }}>
              <ModelName providerId={attempt.providerId} modelId={attempt.modelId} />
            </div>
            {/*
              Los proveedores mandan párrafos de una sola línea: el rate limit de Groq
              nombra el modelo, la organización, el tier y el cubo agotado del tirón. En
              una celda de tabla, que no parte líneas, eso estiraba la tabla entera.
            */}
            <pre className="mono" style={messageBlock}>
              {attempt.message}
            </pre>
          </div>
        ))}
    </div>
  );
}

/** Mismo aspecto que los bloques de prompt y respuesta, pero para texto del proveedor. */
const messageBlock: React.CSSProperties = {
  margin: 0,
  padding: '6px 8px',
  fontSize: 12,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  maxHeight: 120,
  overflowY: 'auto',
};

function Block({ title, text }: { title: string; text: string | null | undefined }) {
  return (
    <div>
      <div className="dim" style={{ marginBottom: 4 }}>
        {title}
      </div>
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: 10,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 260,
          overflowY: 'auto',
        }}
      >
        {text && text.length > 0 ? text : <span className="dim">(vacío)</span>}
      </pre>
    </div>
  );
}
