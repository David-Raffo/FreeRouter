import { useEffect, useState } from 'react';
import {
  api,
  CAPABILITY_LABELS,
  PROFILE_LABELS,
  type ApiKeyRow,
  type Capability,
  type KeyPreview,
  type Profile,
} from '../api';

const PROFILES: Profile[] = ['rapido', 'balanceado', 'calidad'];
const CAPABILITIES: Capability[] = ['vision', 'audio', 'tools', 'long_context', 'image_output'];

interface Props {
  keys: ApiKeyRow[];
  onChange: () => void;
}

/**
 * Creación de API keys. Aquí es donde el usuario elige perfil y capacidades — y donde
 * el router deja de ser una caja negra: antes de crear la key se enseña qué modelos la
 * atenderían, para que "ninguno" salga a la cara en vez de convertirse en un 503.
 */
export function Keys({ keys, onChange }: Props) {
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<Profile>('balanceado');
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [preview, setPreview] = useState<KeyPreview | null>(null);
  const [created, setCreated] = useState<ApiKeyRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .previewKey(profile, capabilities)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [profile, capabilities]);

  function toggle(capability: Capability) {
    setCapabilities((current) =>
      current.includes(capability) ? current.filter((item) => item !== capability) : [...current, capability],
    );
  }

  async function create() {
    setError(null);
    try {
      const record = await api.createKey(name, profile, capabilities);
      setCreated(record);
      setName('');
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="stack">
      <div className="card stack">
        <h2>Nueva API key</h2>

        <input type="text" placeholder="Nombre (p. ej. «mi editor»)" value={name} onChange={(e) => setName(e.target.value)} />

        <div>
          <div className="dim" style={{ marginBottom: 6 }}>
            Perfil
          </div>
          <div className="row wrap">
            {PROFILES.map((option) => (
              <label key={option} className={`check ${profile === option ? 'on' : ''}`} title={PROFILE_LABELS[option].hint}>
                <input
                  type="radio"
                  name="profile"
                  checked={profile === option}
                  onChange={() => setProfile(option)}
                  style={{ display: 'none' }}
                />
                {PROFILE_LABELS[option].title}
              </label>
            ))}
          </div>
          <p className="hint">{PROFILE_LABELS[profile].hint}</p>
        </div>

        <div>
          <div className="dim" style={{ marginBottom: 6 }}>
            Necesito que el modelo pueda…
          </div>
          <div className="row wrap">
            {CAPABILITIES.map((capability) => (
              <label key={capability} className={`check ${capabilities.includes(capability) ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  checked={capabilities.includes(capability)}
                  onChange={() => toggle(capability)}
                  style={{ display: 'none' }}
                />
                {CAPABILITY_LABELS[capability]}
              </label>
            ))}
          </div>
        </div>

        <Preview preview={preview} />

        {error && <div className="notice bad">{error}</div>}

        <div className="row spread">
          <span className="dim">La clave solo se muestra una vez.</span>
          <button className="primary" onClick={() => void create()}>
            Crear API key
          </button>
        </div>
      </div>

      {created?.key && (
        <div className="card stack">
          <h2>Tu nueva API key</h2>
          <div className="notice warn">Cópiala ahora: solo se guarda su hash, no se puede volver a mostrar.</div>

          <Campo
            etiqueta="Base URL"
            valor={baseUrl()}
            nota="Desde otro dispositivo, cambia el host por la IP o el dominio de este servidor."
          />
          <Campo etiqueta="API key" valor={created.key} />

          <Usage apiKey={created.key} />
        </div>
      )}

      <h3>API keys activas</h3>
      {keys.length === 0 ? (
        <div className="notice">Todavía no has creado ninguna.</div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Clave</th>
                <th>Perfil</th>
                <th>Capacidades</th>
                <th>Último uso</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td className="mono dim">{key.prefix}…</td>
                  <td>{PROFILE_LABELS[key.profile].title}</td>
                  <td>
                    {key.capabilities.length === 0 ? (
                      <span className="dim">ninguna</span>
                    ) : (
                      key.capabilities.map((capability) => (
                        <span key={capability} className="pill" style={{ marginRight: 4 }}>
                          {CAPABILITY_LABELS[capability]}
                        </span>
                      ))
                    )}
                  </td>
                  <td className="dim">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'nunca'}</td>
                  <td>
                    <button
                      className="danger"
                      onClick={() => {
                        void api.revokeKey(key.id).then(onChange);
                      }}
                    >
                      Revocar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Base URL que hay que pegar en el cliente. Se deriva de la dirección con la que estás
 * viendo el panel, no de una constante: si entras desde otro equipo de la red, la que
 * necesitas es esa y no `localhost`.
 */
function baseUrl(): string {
  return `${window.location.origin}/v1`;
}

function Campo({ etiqueta, valor, nota }: { etiqueta: string; valor: string; nota?: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <div>
      <div className="dim" style={{ marginBottom: 4 }}>
        {etiqueta}
      </div>
      <div className="row">
        <input type="text" readOnly value={valor} className="mono" onFocus={(e) => e.target.select()} />
        <button
          className="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(valor).then(() => {
              setCopiado(true);
              setTimeout(() => setCopiado(false), 1500);
            });
          }}
        >
          {copiado ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      {nota && (
        <p className="hint" style={{ fontSize: 12 }}>
          {nota}
        </p>
      )}
    </div>
  );
}

function Preview({ preview }: { preview: KeyPreview | null }) {
  if (!preview) return null;

  if (preview.matches === 0) {
    return (
      <div className="notice bad">
        Ningún modelo conectado cubre esta combinación, así que las peticiones con esta key fallarían con un 503.
        Prueba a quitar alguna capacidad o a conectar otro proveedor.
      </div>
    );
  }

  return (
    <div className="notice">
      <strong>
        {preview.matches} {preview.matches === 1 ? 'modelo disponible' : 'modelos disponibles'}
      </strong>
      <div className="dim" style={{ marginTop: 4 }}>
        Ahora mismo se serviría con{' '}
        <span className="mono">
          {preview.top[0]?.providerId}/{preview.top[0]?.modelId}
        </span>
        {preview.top.length > 1 && ` (y ${preview.top.length - 1} más de reserva)`}.
      </div>
    </div>
  );
}

function Usage({ apiKey }: { apiKey: string }) {
  const snippet = `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl()}",
    api_key="${apiKey}",
)

# El modelo lo elige FreeRouter; este campo se ignora.
respuesta = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hola"}],
)
print(respuesta.choices[0].message.content)`;

  return (
    <div>
      <div className="dim" style={{ marginBottom: 6 }}>
        Cómo usarla
      </div>
      <pre className="card mono" style={{ margin: 0, overflowX: 'auto', whiteSpace: 'pre' }}>
        {snippet}
      </pre>
    </div>
  );
}
