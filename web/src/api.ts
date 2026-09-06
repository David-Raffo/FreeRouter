/** Cliente de la API del panel. Tipos espejo de lo que devuelve `routes/admin.ts`. */

export type Profile = 'rapido' | 'balanceado' | 'calidad';
export type Capability = 'vision' | 'audio' | 'tools' | 'long_context' | 'image_output';

export interface QuotaLimits {
  rpm: number | null;
  tpm: number | null;
  rpd: number | null;
  tpd: number | null;
}

export interface FreeTierInfo {
  renewing: boolean;
  note: string;
}

export interface ProviderCard {
  id: string;
  label: string;
  freeTier: FreeTierInfo;
  keyHint: string;
  consoleUrl: string;
  quotaScope: 'model' | 'account';
  /** El proveedor sirve sin clave; el botón de conectar no exige rellenar nada. */
  keyOptional: boolean;
  /** Aviso a mostrar antes de conectar (formato de credencial, privacidad…). */
  warning: string | null;
  connected: boolean;
  status: 'active' | 'invalid' | null;
  last4: string | null;
  addedAt: string | null;
  lastError: string | null;
  limits: QuotaLimits;
  models: number;
}

export interface QuotaStatus {
  limits: QuotaLimits;
  minuteRequests: number;
  minuteTokens: number;
  dailyRequests: number;
  dailyTokens: number;
  cooldownMs: number;
}

export type QualitySource = 'measured' | 'approx' | 'estimated';

export type ModelState = 'active' | 'cooldown' | 'no_quota' | 'quarantined' | 'disabled' | 'provider_down';

export type ModelSort = 'speed' | 'quality';

export interface ModelsPage {
  rows: ModelRow[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  summary: { total: number; routable: number; uncalibrated: number; calibrating: boolean };
}

export interface ModelRow {
  providerId: string;
  id: string;
  displayName: string;
  contextLength: number;
  capabilities: Capability[];
  qualityScore: number | null;
  qualitySource: QualitySource | null;
  enabled: boolean;
  ttftMs: number | null;
  tps: number | null;
  samples: number;
  lastError: string | null;
  quarantined: boolean;
  quarantinedUntil: string | null;
  providerStatus: 'active' | 'invalid' | null;
  state: ModelState;
  quota: QuotaStatus;
}

export interface ApiKeyRow {
  id: string;
  prefix: string;
  name: string;
  profile: Profile;
  capabilities: Capability[];
  createdAt: string;
  lastUsedAt: string | null;
  /** Solo viene en la respuesta a la creación; después es irrecuperable. */
  key?: string;
}

export interface QualityMeta {
  indexVersion: string;
  measuredAt: string;
  syncedAt: string | null;
  attribution: string;
  /** Cuántos modelos tienen índice medido en el catálogo. */
  measuredModels: number;
}

export interface Status {
  connectedProviders: number;
  activeProviders: number;
  models: number;
  apiKeys: number;
  quality: QualityMeta;
  onboardingComplete: boolean;
}

export interface KeyPreview {
  matches: number;
  top: Array<{
    providerId: string;
    modelId: string;
    score: number;
    qualityScore: number | null;
    qualitySource: QualitySource | null;
    ttftMs: number | null;
    tps: number | null;
  }>;
  rejected: number;
}

export interface ActivityRow {
  id: number;
  ts: string;
  provider_id: string | null;
  model_id: string | null;
  profile: string | null;
  ok: number;
  ttft_ms: number | null;
  total_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  error_kind: string | null;
  attempts: number;
  tps: number | null;
  /** Nombre de la API key que hizo la llamada. */
  api_key_name: string | null;
  /** 1 si hay prompt o respuesta guardados. */
  has_content: number;
}

/** Un intento contra un modelo, con lo que costó. */
export interface AttemptDetail {
  providerId: string;
  modelId: string;
  ok: boolean;
  ms: number;
  ttftMs: number | null;
  errorKind: string | null;
  message: string | null;
}

export interface ActivityDetail {
  prompt: string | null;
  response: string | null;
  /** A quién se intentó y en qué orden. Vacío en peticiones anteriores a esta función. */
  timeline: AttemptDetail[];
  /** Tiempo gastado decidiendo, sin contar la espera a los proveedores. */
  routerMs: number | null;
}

export interface AuthState {
  authenticated: boolean;
  disabled: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // El content-type solo se declara si hay cuerpo. Mandarlo en un DELETE o en un POST
  // sin cuerpo hace que el servidor responda 400: no hay JSON que interpretar.
  const headers = init?.body ? { 'content-type': 'application/json', ...(init.headers ?? {}) } : init?.headers;
  const response = await fetch(path, { ...init, ...(headers ? { headers } : {}) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error ?? `Error ${response.status}`);
  }
  return payload as T;
}

export const api = {
  status: () => request<Status>('/api/status'),
  providers: () => request<ProviderCard[]>('/api/providers'),
  connect: (id: string, key: string) =>
    request<{ ok: boolean; models: number; notes: string[]; capabilities: Record<string, number> }>(
      `/api/providers/${id}/key`,
      { method: 'POST', body: JSON.stringify({ key }) },
    ),
  refresh: (id: string) => request<{ ok: boolean; models: number }>(`/api/providers/${id}/refresh`, { method: 'POST' }),
  disconnect: (id: string) => request<{ ok: boolean }>(`/api/providers/${id}`, { method: 'DELETE' }),
  models: (options: { sort?: ModelSort; page?: number; pageSize?: number; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.sort) params.set('sort', options.sort);
    if (options.page) params.set('page', String(options.page));
    if (options.pageSize) params.set('pageSize', String(options.pageSize));
    if (options.q) params.set('q', options.q);
    return request<ModelsPage>(`/api/models?${params.toString()}`);
  },
  /**
   * El id del modelo va en el cuerpo, nunca en la ruta: llevan barras (`@cf/meta/...`)
   * y aunque se escapen como `%2F`, los proxys inversos las decodifican antes de
   * reenviar y el servidor acaba recibiendo una ruta que no existe.
   */
  setModelEnabled: (providerId: string, modelId: string, enabled: boolean) =>
    request<{ ok: boolean }>('/api/models/enabled', {
      method: 'POST',
      body: JSON.stringify({ providerId, modelId, enabled }),
    }),
  keys: () => request<ApiKeyRow[]>('/api/keys'),
  previewKey: (profile: Profile, capabilities: Capability[]) =>
    request<KeyPreview>('/api/keys/preview', { method: 'POST', body: JSON.stringify({ profile, capabilities }) }),
  createKey: (name: string, profile: Profile, capabilities: Capability[]) =>
    request<ApiKeyRow>('/api/keys', { method: 'POST', body: JSON.stringify({ name, profile, capabilities }) }),
  revokeKey: (id: string) => request<{ ok: boolean }>(`/api/keys/${id}`, { method: 'DELETE' }),
  authState: () => request<AuthState>('/api/auth/state'),
  login: (password: string) =>
    request<{ ok: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  activity: () => request<ActivityRow[]>('/api/activity'),
  activityDetail: (id: number) => request<ActivityDetail>(`/api/activity/${id}`),
  clearActivityContent: () => request<{ ok: boolean }>('/api/activity', { method: 'DELETE' }),
  loggingSettings: () => request<{ logContent: boolean }>('/api/settings/logging'),
  measurementSettings: () => request<{ measureTtft: boolean }>('/api/settings/measurement'),
  setMeasurement: (measureTtft: boolean) =>
    request<{ measureTtft: boolean }>('/api/settings/measurement', {
      method: 'POST',
      body: JSON.stringify({ measureTtft }),
    }),
  setLogging: (logContent: boolean) =>
    request<{ logContent: boolean }>('/api/settings/logging', {
      method: 'POST',
      body: JSON.stringify({ logContent }),
    }),
  warmup: (force = false) =>
    request<{ started: boolean; reason?: string }>(`/api/warmup${force ? '?force=true' : ''}`, { method: 'POST' }),
};

export const STATE_LABELS: Record<ModelState, { text: string; tone: 'ok' | 'warn' | 'bad' | '' }> = {
  active: { text: 'activo', tone: 'ok' },
  cooldown: { text: 'esperando', tone: 'warn' },
  no_quota: { text: 'sin cuota', tone: 'warn' },
  quarantined: { text: 'en cuarentena', tone: 'bad' },
  disabled: { text: 'desactivado', tone: '' },
  provider_down: { text: 'proveedor no disponible', tone: 'bad' },
};

export const CAPABILITY_LABELS: Record<Capability, string> = {
  vision: 'Visión',
  audio: 'Audio',
  tools: 'Tool use',
  long_context: 'Contexto largo',
  image_output: 'Generar imagen',
};

export const PROFILE_LABELS: Record<Profile, { title: string; hint: string }> = {
  rapido: { title: 'Rápido', hint: 'Prioriza la latencia. Ideal para autocompletado y chat.' },
  balanceado: { title: 'Balanceado', hint: 'Reparte a partes iguales velocidad y calidad.' },
  calidad: { title: 'Calidad', hint: 'Prioriza el mejor modelo disponible aunque tarde más.' },
};
