import { useState } from 'react';
import { api } from '../api';

/**
 * Login del panel.
 *
 * No hay asistente de instalación: la contraseña se define en el `.env` y el servidor no
 * arranca sin ella, así que si esta pantalla se ve es que ya existe una.
 */
export function Auth({ onReady }: { onReady: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await api.login(password);
      onReady();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell" style={{ maxWidth: 400, paddingTop: 72 }}>
      <header className="top">
        <h1>FreeRouter</h1>
      </header>

      <div className="card stack" style={{ marginTop: 16 }}>
        <h2>Inicia sesión</h2>

        <input
          type="password"
          placeholder="Contraseña"
          value={password}
          autoFocus
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && password.length > 0) void submit();
          }}
        />

        {error && <div className="notice bad">{error}</div>}

        <button className="primary" disabled={busy || password.length === 0} onClick={() => void submit()}>
          {busy ? 'Un momento…' : 'Entrar'}
        </button>

        <p className="hint" style={{ fontSize: 12 }}>
          Es la que pusiste en <code>FREEROUTER_PASSWORD</code>. Para cambiarla, edítala en el <code>.env</code> y
          reinicia: <code>docker compose up -d</code>.
        </p>
      </div>
    </div>
  );
}
