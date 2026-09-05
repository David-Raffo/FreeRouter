/**
 * Estimación de tokens.
 *
 * No tokenizamos de verdad: cada proveedor usa su propio tokenizador y cargar tres
 * sería absurdo para lo que necesitamos. Lo único que hace falta es una cota
 * razonable para (a) descartar modelos cuyo contexto no da, y (b) reservar cuota de
 * TPM antes de llamar. Se redondea al alza a propósito: quedarse corto provoca el 429
 * que intentamos evitar, pasarse solo cuesta un poco de cuota.
 */

/** Caracteres por token en texto latino. Conservador (el real ronda 3,5-4). */
const CHARS_PER_TOKEN = 3.5;
/** Coste aproximado de una imagen en tokens de entrada. */
const TOKENS_PER_IMAGE = 800;
/** Margen por el andamiaje del chat (roles, separadores, plantilla). */
const OVERHEAD_PER_MESSAGE = 4;

interface ContentPart {
  type?: string;
  text?: string;
  image_url?: unknown;
}

interface Message {
  role?: string;
  content?: string | ContentPart[] | null;
  tool_calls?: unknown[];
  name?: string;
}

export interface TokenEstimate {
  prompt: number;
  /** Prompt + la respuesta máxima que puede generar. */
  total: number;
  hasImages: boolean;
  hasAudio: boolean;
}

export function estimateTokens(body: Record<string, unknown>): TokenEstimate {
  const messages = Array.isArray(body.messages) ? (body.messages as Message[]) : [];
  let prompt = 0;
  let hasImages = false;
  let hasAudio = false;

  for (const message of messages) {
    prompt += OVERHEAD_PER_MESSAGE;
    const content = message.content;

    if (typeof content === 'string') {
      prompt += charsToTokens(content.length);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          prompt += charsToTokens(part.text.length);
        } else if (part.type === 'image_url' || part.type === 'image') {
          hasImages = true;
          prompt += TOKENS_PER_IMAGE;
        } else if (part.type === 'input_audio' || part.type === 'audio') {
          hasAudio = true;
          prompt += TOKENS_PER_IMAGE;
        }
      }
    }

    if (Array.isArray(message.tool_calls)) {
      prompt += charsToTokens(JSON.stringify(message.tool_calls).length);
    }
  }

  // Las definiciones de herramientas viajan en cada petición y pesan.
  if (Array.isArray(body.tools)) {
    prompt += charsToTokens(JSON.stringify(body.tools).length);
  }
  if (typeof body.system === 'string') {
    prompt += charsToTokens(body.system.length);
  }

  const maxCompletion = readMaxTokens(body) ?? 1024;
  return { prompt, total: prompt + maxCompletion, hasImages, hasAudio };
}

function readMaxTokens(body: Record<string, unknown>): number | null {
  const candidates = [body.max_completion_tokens, body.max_tokens];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function charsToTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** ¿La petición pide tool use? */
export function requestUsesTools(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}
