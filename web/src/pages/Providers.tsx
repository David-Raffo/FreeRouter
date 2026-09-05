import { useState } from 'react';
import { api, type ProviderCard } from '../api';

interface Props {
  providers: ProviderCard[];
  onChange: () => void;
}

/**
 * Conexión de proveedores. Todo funciona con una sola clave; las tres solo dan más
 * margen al router para repartir carga.
 */
export function Providers({ providers, onChange }: Props) {
  return (
    <div className="stack">
      <p className="hint">
        Pega las claves de los proveedores que uses. Con una basta — cuantas más conectes, más opciones tiene el router
        para repartir la carga y esquivar los límites.
      </p>
      <div className="grid">
        {providers.map((provider) => (
          <ProviderTile key={provider.id} provider={provider} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}

function ProviderTile({ provider, onChange }: { provider: ProviderCard; onChange: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.connect(provider.id, value.trim());
      setNotes(result.notes);
      setValue('');
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <div className="row spread">
        <h2>{provider.label}</h2>
        {provider.connected ? (
          <span className={`pill ${provider.status === 'active' ? 'ok' : 'bad'}`}>
            {provider.status === 'active' ? `···${provider.last4}` : 'clave rechazada'}
          </span>
        ) : (
          <span className="pill">sin conectar</span>
        )}
      </div>

      <div className="dim" style={{ fontSize: 13 }}>
        <Limits provider={provider} />
      </div>

      {provider.warning && !provider.connected && <div className="notice warn">{provider.warning}</div>}

      {!provider.freeTier.renewing && (
        <div className="notice warn">
          <strong>Ya no tiene cuota gratuita renovable.</strong>
          <div style={{ marginTop: 4 }}>{provider.freeTier.note}</div>
        </div>
      )}

      {provider.connected ? (
        <>
          <div className="row wrap">
            <span className="pill">{provider.models} modelos</span>
            <button className="ghost" disabled={busy} onClick={() => void run(() => api.refresh(provider.id))}>
              Refrescar modelos
            </button>
            <button className="danger" disabled={busy} onClick={() => void run(() => api.disconnect(provider.id))}>
              Quitar
            </button>
          </div>
          {provider.lastError && <div className="notice bad">{provider.lastError}</div>}
        </>
      ) : (
        <>
          <input
            type="password"
            placeholder={provider.keyHint}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (value.trim() || provider.keyOptional)) void connect();
            }}
          />
          <div className="row spread">
            <a href={provider.consoleUrl} target="_blank" rel="noreferrer">
              Conseguir una clave
            </a>
            <button
              className="primary"
              disabled={busy || (!value.trim() && !provider.keyOptional)}
              onClick={() => void connect()}
            >
              {busy ? 'Validando…' : provider.keyOptional && !value.trim() ? 'Conectar sin clave' : 'Conectar'}
            </button>
          </div>
        </>
      )}

      {error && <div className="notice bad">{error}</div>}
      {notes.map((note) => (
        <div key={note} className="notice">
          {note}
        </div>
      ))}
    </div>
  );
}

function Limits({ provider }: { provider: ProviderCard }) {
  const parts: string[] = [];
  if (provider.limits.rpm !== null) parts.push(`${provider.limits.rpm} req/min`);
  if (provider.limits.rpd !== null) parts.push(`${provider.limits.rpd} req/día`);
  if (provider.limits.tpm !== null) parts.push(`${format(provider.limits.tpm)} tok/min`);
  if (provider.limits.tpd !== null) parts.push(`${format(provider.limits.tpd)} tok/día`);
  const scope = provider.quotaScope === 'account' ? 'por cuenta' : 'por modelo';
  return <>{parts.length > 0 ? `${parts.join(' · ')} — ${scope}` : 'Sin límites conocidos'}</>;
}

function format(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`;
  if (value >= 1000) return `${value / 1000}K`;
  return String(value);
}
