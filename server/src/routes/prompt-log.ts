/**
 * Cómo se guarda el prompt en el historial.
 *
 * Vive aparte de las rutas porque es lógica pura con una decisión detrás —a quién se le
 * quita sitio cuando no cabe todo— y eso se prueba mejor sin levantar un servidor.
 */

import { LOG_TEXT_LIMIT } from '../store.js';

/**
 * Presupuesto de caracteres del prompt guardado. Por debajo del límite de la base de
 * datos, para que el JSON quepa entero con sus comillas y llaves.
 */
const PROMPT_BUDGET = 3500;

export interface PromptPart {
  role: string;
  text: string;
  /** El mensaje no cupo entero en el presupuesto. */
  trimmed?: boolean;
}

/** Aplana el contenido de un mensaje, que puede venir como texto o como lista de partes. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const typed = part as { type?: string; text?: string };
      if (typed.type === 'text') return typed.text ?? '';
      return `[${typed.type ?? 'adjunto'}]`;
    })
    .join('');
}

/**
 * Guarda el prompt por mensajes, no como un bloque de texto.
 *
 * Antes se pegaba todo y se cortaba a 4.000 caracteres desde el principio, con dos
 * consecuencias malas cuando el prompt de sistema es largo: en el panel había que bajar
 * media pantalla para ver lo que preguntó el usuario, y si el sistema pasaba del límite
 * el mensaje del usuario **no llegaba a guardarse**.
 *
 * Por eso el presupuesto se reparte desde el final: lo último que se dijo es lo que
 * interesa ver, así que se conserva entero y lo que sobra se lo lleva el sistema, que
 * queda recortado y marcado como tal.
 */
export function renderPromptParts(messages: unknown[]): string {

  const parts: PromptPart[] = [];
  let left = PROMPT_BUDGET;
  let omitted = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown };
    const role = String(message.role ?? 'user');
    const text = flattenContent(message.content);

    if (left <= 0) {
      omitted += 1;
      continue;
    }
    if (text.length <= left) {
      parts.unshift({ role, text });
      left -= text.length;
    } else {
      parts.unshift({ role, text: text.slice(0, left), trimmed: true });
      left = 0;
    }
  }

  // El presupuesto anterior cuenta texto, pero lo que se guarda es JSON: los saltos de
  // línea se escapan y cada mensaje añade sus llaves. Si el serializado se pasa del
  // límite de la base de datos lo cortarían a medias y dejaría de ser JSON válido, así
  // que se recorta desde el principio —lo más viejo— hasta que quepa de verdad.
  let payload = JSON.stringify({ parts, omitted });
  while (payload.length > LOG_TEXT_LIMIT && parts.length > 0) {
    const first = parts[0]!;
    if (first.text.length === 0) {
      parts.shift();
      omitted += 1;
    } else {
      const exceso = payload.length - LOG_TEXT_LIMIT;
      first.text = first.text.slice(0, Math.max(0, first.text.length - Math.max(exceso, 64)));
      first.trimmed = true;
    }
    payload = JSON.stringify({ parts, omitted });
  }
  return payload;
}

