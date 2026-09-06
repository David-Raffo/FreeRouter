import { useEffect, useState } from 'react';
import {
  api,
  CAPABILITY_LABELS,
  STATE_LABELS,
  type ModelRow,
  type ModelSort,
  type ModelsPage,
  type QuotaStatus,
} from '../api';
import { ModelName } from '../ui';

const PAGE_SIZE = 25;
const REFRESH_MS = 5000;

/**
 * Estado en vivo de los modelos.
 *
 * El orden y la paginación se resuelven en el servidor: con un catálogo de miles de
 * modelos, mandar la lista entera cada pocos segundos serían megabytes por refresco.
 */
export function Dashboard() {
  const [sort, setSort] = useState<ModelSort>('speed');
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [data, setData] = useState<ModelsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Qué acabas de hacer, y cómo deshacerlo.
   *
   * Sin esto la acción era invisible: los modelos apagados caen al final de la lista, así
   * que al desactivar uno la fila desaparece de la página y la tabla se recoloca sola. El
   * botón funcionaba, pero parecía de adorno. Y volver a encontrar el modelo entre los
   * sesenta del fondo para deshacerlo no era razonable.
   */
  const [notice, setNotice] = useState<{ text: string; undo: () => void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .models({ sort, page, pageSize: PAGE_SIZE, q: query })
        .then((next) => {
          if (!cancelled) {
            setData(next);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sort, page, query]);

  // Al cambiar de orden o de búsqueda, la página en la que estabas deja de tener sentido.
  useEffect(() => {
    setPage(1);
  }, [sort, query]);

  if (error) return <div className="notice bad">No se pudo cargar el listado: {error}</div>;
  if (!data) return <div className="dim">Cargando…</div>;

  if (data.summary.total === 0) {
    return <div className="notice">Todavía no hay modelos. Conecta un proveedor en la pestaña «Proveedores».</div>;
  }

  function reload() {
    void api.models({ sort, page, pageSize: PAGE_SIZE, q: query }).then(setData);
  }

  function toggle(model: ModelRow) {
    const enabled = !model.enabled;
    const nombre = `${model.providerId}/${model.id}`;
    void api.setModelEnabled(model.providerId, model.id, enabled).then(() => {
      reload();
      setNotice({
        text: enabled
          ? `${nombre} vuelve al enrutado.`
          : `${nombre} desactivado. Ha bajado al final de la lista.`,
        undo: () => {
          void api.setModelEnabled(model.providerId, model.id, !enabled).then(() => {
            reload();
            setNotice(null);
          });
        },
      });
    });
  }

  return (
    <div className="stack">
      <CalibrationStatus summary={data.summary} />

      {notice && (
        <div className="notice row spread wrap">
          <span>{notice.text}</span>
          <div className="row">
            <button className="ghost" onClick={notice.undo}>
              Deshacer
            </button>
            <button className="ghost" onClick={() => setNotice(null)}>
              Cerrar
            </button>
          </div>
        </div>
      )}

      <div className="row spread wrap">
        <div className="row wrap">
          <span className="dim">Ordenar por</span>
          {(['speed', 'quality'] as ModelSort[]).map((option) => (
            <label key={option} className={`check ${sort === option ? 'on' : ''}`}>
              <input
                type="radio"
                name="sort"
                checked={sort === option}
                onChange={() => setSort(option)}
                style={{ display: 'none' }}
              />
              {option === 'speed' ? 'Velocidad' : 'Calidad'}
            </label>
          ))}
        </div>
        <input
          type="text"
          placeholder="Filtrar por nombre…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ maxWidth: 260 }}
        />
      </div>

      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Modelo</th>
              <th>Estado</th>
              <th title="Tiempo hasta el primer token">TTFT</th>
              <th title="Tokens generados entre el tiempo total de la petición. Se mide sobre el total y no sobre el intervalo de streaming porque algunos proveedores entregan la respuesta en ráfaga, y ahí el streaming mide la descarga y no la generación.">
                tok/s (total)
              </th>
              <th>Calidad</th>
              <th>Cuota hoy</th>
              <th>Capacidades</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((model) => (
              <tr key={`${model.providerId}:${model.id}`}>
                <td>
                  <ModelName providerId={model.providerId} modelId={model.id} />
                </td>
                <td>
                  <State model={model} />
                </td>
                <td>{model.ttftMs === null ? <span className="dim">—</span> : `${Math.round(model.ttftMs)} ms`}</td>
                <td>
                  {model.tps === null ? <span className="dim">sin medir</span> : `${Math.round(model.tps)} tok/s`}
                </td>
                <td>
                  <Quality model={model} />
                </td>
                <td style={{ minWidth: 150 }}>
                  <Quota quota={model.quota} />
                </td>
                <td>
                  {model.capabilities.length === 0 ? (
                    <span className="dim">texto</span>
                  ) : (
                    model.capabilities.map((capability) => (
                      <span key={capability} className="pill" style={{ marginRight: 4 }}>
                        {CAPABILITY_LABELS[capability]}
                      </span>
                    ))
                  )}
                </td>
                <td>
                  <button
                    className="ghost"
                    title={
                      model.enabled
                        ? 'Sacar este modelo del enrutado'
                        : 'Volver a incluirlo. Se desactivan solos los modelos que el proveedor rechaza.'
                    }
                    onClick={() => toggle(model)}
                  >
                    {model.enabled ? 'Desactivar' : 'Activar'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={data.page} pages={data.pages} total={data.total} onChange={setPage} />
    </div>
  );
}

function Pagination({
  page,
  pages,
  total,
  onChange,
}: {
  page: number;
  pages: number;
  total: number;
  onChange: (page: number) => void;
}) {
  if (pages <= 1) return <span className="dim">{total} modelos</span>;
  return (
    <div className="row spread wrap">
      <span className="dim">
        {total} modelos · página {page} de {pages}
      </span>
      <div className="row">
        <button className="ghost" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Anterior
        </button>
        <button className="ghost" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          Siguiente
        </button>
      </div>
    </div>
  );
}

/**
 * Progreso de la calibración. Sin botón: medir es automático al arrancar y al conectar
 * un proveedor, así que aquí solo se informa de por dónde va.
 */
function CalibrationStatus({ summary }: { summary: ModelsPage['summary'] }) {
  if (summary.calibrating) {
    const medidos = summary.routable - summary.uncalibrated;
    return (
      <div className="notice">
        Calibrando velocidad… {medidos} de {summary.routable} modelos medidos. Se actualiza solo.
      </div>
    );
  }
  if (summary.uncalibrated > 0) {
    return (
      <div className="dim">
        {summary.uncalibrated} de {summary.routable} modelos aún sin medir. El sondeo los irá cubriendo; mientras
        tanto el router los ordena por calidad.
      </div>
    );
  }
  return null;
}

/**
 * La puntuación medida y la estimada se enseñan distinto a propósito: un número
 * inventado por una heurística no debe parecer un dato de benchmark.
 */
function Quality({ model }: { model: ModelRow }) {
  if (model.qualityScore === null) return <span className="dim">—</span>;
  const value = Math.round(model.qualityScore);

  if (model.qualitySource === 'measured') {
    return <span title="Intelligence Index medido por Artificial Analysis para este modelo">{value}</span>;
  }
  if (model.qualitySource === 'approx') {
    return (
      <span title="Nota del mismo modelo en otra instantánea: el proveedor sirve una versión fechada que el índice no evalúa por separado">
        ≈{value}
      </span>
    );
  }
  return (
    <span className="dim" title="Sin evaluar: estimación por familia de modelo">
      ~{value}
    </span>
  );
}

function State({ model }: { model: ModelRow }) {
  const label = STATE_LABELS[model.state];
  const text =
    model.state === 'cooldown' ? `${label.text} ${Math.ceil(model.quota.cooldownMs / 1000)} s` : label.text;
  return (
    <span className={`pill ${label.tone}`} title={model.lastError ?? undefined}>
      {text}
    </span>
  );
}

function Quota({ quota }: { quota: QuotaStatus }) {
  const { limits } = quota;
  // Se enseña el cubo diario, que es el que de verdad limita el uso a lo largo del día.
  const limit = limits.rpd ?? limits.tpd;
  const used = limits.rpd !== null ? quota.dailyRequests : quota.dailyTokens;
  const unit = limits.rpd !== null ? 'req' : 'tok';

  if (limit === null || limit === 0) {
    return <span className="dim">{quota.dailyRequests} req hoy</span>;
  }

  const ratio = Math.min(1, used / limit);
  const tone = ratio > 0.9 ? 'bad' : ratio > 0.7 ? 'warn' : '';
  return (
    <div className="row">
      <div className="bar">
        <span className={tone} style={{ width: `${ratio * 100}%` }} />
      </div>
      <span className="dim" style={{ fontSize: 12 }}>
        {used}/{limit} {unit}
      </span>
    </div>
  );
}
