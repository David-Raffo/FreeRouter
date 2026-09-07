/**
 * Quitar el razonamiento de lo que se le manda al cliente.
 *
 * No se le pide al modelo que deje de razonar —razona igual, y por eso responde mejor—:
 * lo único que cambia es qué se transmite. Un chatbot que enseña el «thinking» al usuario
 * final está enseñando las tripas.
 *
 * Los proveedores lo cuelan de dos maneras distintas, y hay que tapar las dos:
 *
 *  - **Campo aparte**: `reasoning_content` (DeepSeek y quien copia su formato) o
 *    `reasoning` (OpenRouter). Fácil: se borra del mensaje.
 *  - **Dentro del propio texto**, entre etiquetas `<think>…</think>`. Es lo que hacen los
 *    Qwen de razonamiento, y lo difícil: en streaming la etiqueta llega partida entre dos
 *    trozos («<thi» y «nk>»), así que hace falta un filtro con memoria que retenga lo que
 *    todavía podría ser el principio de una etiqueta.
 */

/** Campos con los que un proveedor manda el razonamiento por separado. */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_details'];

/** Etiquetas vistas en la práctica. Se comparan en minúsculas. */
const TAGS = [
  { open: '<think>', close: '</think>' },
  { open: '<thinking>', close: '</thinking>' },
  { open: '<reasoning>', close: '</reasoning>' },
];

/**
 * Cuántos caracteres del final hay que guardarse porque podrían ser una etiqueta a
 * medias. Cero en cuanto la cola deja de parecerse a una, que es el caso normal: así el
 * texto corriente sale al momento y no con retraso.
 */
function retenerCola(pending: string): number {
  const start = pending.lastIndexOf('<');
  if (start < 0) return 0;
  const tail = pending.slice(start).toLowerCase();
  const posible = TAGS.some((t) => t.open.startsWith(tail) || t.close.startsWith(tail));
  return posible ? pending.length - start : 0;
}

function stripFields(message: Record<string, unknown>): void {
  for (const field of REASONING_FIELDS) delete message[field];
}

/**
 * Filtro con memoria para el texto que va llegando a trozos.
 *
 * Mantiene dos cosas: si estamos dentro de un bloque de razonamiento, y una cola con el
 * final del texto que todavía podría ser el comienzo de una etiqueta partida. Esa cola es
 * lo que impide que «<thi» + «nk>» se escape como texto normal.
 */
export function createReasoningFilter(): {
  push(chunk: string): string;
  flush(): string;
  sawReasoning(): boolean;
} {
  let pending = '';
  let inside = false;
  let saw = false;

  const emit = (chunk: string): string => {
    pending += chunk;
    let out = '';

    for (;;) {
      if (inside) {
        const closeAt = TAGS.map((t) => ({ t, i: pending.toLowerCase().indexOf(t.close) }))
          .filter((x) => x.i >= 0)
          .sort((a, b) => a.i - b.i)[0];
        if (!closeAt) {
          // Todo lo acumulado es razonamiento; solo se conserva lo que aún podría ser el
          // principio de la etiqueta de cierre.
          pending = pending.slice(pending.length - retenerCola(pending));
          return out;
        }
        pending = pending.slice(closeAt.i + closeAt.t.close.length);
        inside = false;
        continue;
      }

      const openAt = TAGS.map((t) => ({ t, i: pending.toLowerCase().indexOf(t.open) }))
        .filter((x) => x.i >= 0)
        .sort((a, b) => a.i - b.i)[0];
      if (openAt) {
        out += pending.slice(0, openAt.i);
        pending = pending.slice(openAt.i + openAt.t.open.length);
        inside = true;
        saw = true;
        continue;
      }

      // Sin etiqueta a la vista se suelta todo, salvo una cola que de verdad pueda ser
      // el principio de una. Retener siempre un puñado de caracteres «por si acaso»
      // haría que el texto normal llegase con retraso al cliente, y en streaming eso se
      // nota.
      const keep = retenerCola(pending);
      const safe = pending.length - keep;
      if (safe > 0) {
        out += pending.slice(0, safe);
        pending = pending.slice(safe);
      }
      return out;
    }
  };

  return {
    push: emit,
    /** Lo que quedaba retenido al acabar el stream. */
    flush(): string {
      if (inside) {
        // Bloque sin cerrar: era razonamiento hasta el final, no se emite.
        pending = '';
        return '';
      }
      const rest = pending;
      pending = '';
      return rest;
    },
    sawReasoning: () => saw,
  };
}

/** Quita el razonamiento de una respuesta de una pieza. */
export function stripReasoning(payload: Record<string, unknown>): Record<string, unknown> {
  const choices = payload.choices;
  if (!Array.isArray(choices)) return payload;

  for (const raw of choices) {
    const choice = raw as Record<string, unknown>;
    const message = choice.message as Record<string, unknown> | undefined;
    if (!message) continue;

    stripFields(message);
    if (typeof message.content === 'string') {
      const filter = createReasoningFilter();
      message.content = (filter.push(message.content) + filter.flush()).trimStart();
    }
  }
  return payload;
}

/**
 * Quita el razonamiento de un trozo de streaming, ya interpretado.
 * Devuelve `null` cuando el trozo se queda sin nada que transmitir.
 */
export function stripReasoningFromChunk(
  chunk: Record<string, unknown>,
  filter: ReturnType<typeof createReasoningFilter>,
): Record<string, unknown> | null {
  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) return chunk;

  let anyContent = false;
  let hadContent = false;

  for (const raw of choices) {
    const choice = raw as Record<string, unknown>;
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) continue;

    stripFields(delta);
    if (typeof delta.content === 'string') {
      hadContent = true;
      const visible = filter.push(delta.content);
      if (visible.length > 0) {
        delta.content = visible;
        anyContent = true;
      } else {
        delete delta.content;
      }
    }
  }

  // Un trozo que solo traía razonamiento se descarta entero: reenviarlo vacío haría que
  // algunos clientes pintaran un hueco.
  const meaningful =
    anyContent ||
    !hadContent ||
    choices.some((raw) => {
      const choice = raw as Record<string, unknown>;
      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      return Boolean(choice.finish_reason) || Object.keys(delta).length > 0;
    });

  return meaningful ? chunk : null;
}
