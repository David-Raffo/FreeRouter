import { useCallback, useEffect, useState } from 'react';
import { api, type ActivityRow, type ApiKeyRow, type AuthState, type ProviderCard, type Status } from './api';
import { Auth } from './pages/Auth';
import { Activity } from './pages/Activity';
import { Dashboard } from './pages/Dashboard';
import { Keys } from './pages/Keys';
import { Providers } from './pages/Providers';

type Tab = 'dashboard' | 'activity' | 'providers' | 'keys';

const REFRESH_MS = 5000;

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [status, setStatus] = useState<Status | null>(null);
  const [providers, setProviders] = useState<ProviderCard[]>([]);
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // El listado de modelos lo pide el propio Dashboard, que es quien conoce el
      // orden y la página; traerlo aquí duplicaría la petición más pesada.
      const [nextStatus, nextProviders, nextKeys, nextActivity] = await Promise.all([
        api.status(),
        api.providers(),
        api.keys(),
        api.activity(),
      ]);
      setStatus(nextStatus);
      setProviders(nextProviders);
      setKeys(nextKeys);
      setActivity(nextActivity);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const checkAuth = useCallback(() => api.authState().then(setAuth).catch(() => undefined), []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (!auth?.authenticated) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [auth?.authenticated, load]);

  if (!auth) return <div className="shell dim">Cargando…</div>;
  if (!auth.authenticated) return <Auth onReady={() => void checkAuth()} />;

  // Sin ningún proveedor conectado, lo único que tiene sentido es el onboarding.
  const needsOnboarding = status !== null && !status.onboardingComplete;
  const activeTab: Tab = needsOnboarding ? 'providers' : tab;

  return (
    <div className="shell">
      <header className="top spread">
        <div className="row" style={{ alignItems: 'baseline', gap: 14 }}>
          <h1>FreeRouter</h1>
          <span className="sub">
            {status ? `${status.models} modelos · ${status.activeProviders} proveedores activos` : 'cargando…'}
          </span>
        </div>
        {!auth.disabled && (
          <button
            className="ghost"
            onClick={() => {
              void api.logout().then(() => checkAuth());
            }}
          >
            Cerrar sesión
          </button>
        )}
      </header>

      {error && <div className="notice bad">No se puede hablar con el servidor: {error}</div>}

      {needsOnboarding ? (
        <p className="hint">
          Conecta al menos un proveedor para empezar. Después podrás crear API keys y apuntar cualquier cliente
          compatible con OpenAI a <code>http://localhost:8787/v1</code>.
        </p>
      ) : (
        <nav className="tabs">
          <button aria-selected={activeTab === 'dashboard'} onClick={() => setTab('dashboard')}>
            Estado
          </button>
          <button aria-selected={activeTab === 'activity'} onClick={() => setTab('activity')}>
            Peticiones
          </button>
          <button aria-selected={activeTab === 'providers'} onClick={() => setTab('providers')}>
            Proveedores
          </button>
          <button aria-selected={activeTab === 'keys'} onClick={() => setTab('keys')}>
            API keys
          </button>
        </nav>
      )}

      {activeTab === 'dashboard' && <Dashboard />}
      {activeTab === 'activity' && <Activity rows={activity} />}
      {activeTab === 'providers' && <Providers providers={providers} onChange={() => void load()} />}
      {activeTab === 'keys' && <Keys keys={keys} onChange={() => void load()} />}

      <footer className="credits">
        Calidad de los modelos según el{' '}
        <a href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer">
          Artificial Analysis Intelligence Index
        </a>
        {status && (
          <>
            {' '}
            · {status.quality.measuredModels} modelos con índice medido
            {status.quality.syncedAt
              ? ` · ampliado el ${new Date(status.quality.syncedAt).toLocaleDateString()}`
              : ' · los no medidos se estiman por familia'}
          </>
        )}
      </footer>
    </div>
  );
}
