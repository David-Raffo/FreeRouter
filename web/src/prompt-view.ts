/**
 * Qué parte de una conversación se enseña abierta en el historial.
 *
 * Una petición de chatbot trae toda la conversación hasta el momento, y lo que se quiere
 * mirar casi siempre es el último intercambio: la última respuesta del asistente y lo que
 * el usuario contestó a eso. Con veinte turnos delante, había que bajar media pantalla
 * para encontrarlo.
 *
 * Así que la conversación se parte en tres:
 *
 *  - el prompt de sistema, plegado aparte;
 *  - lo anterior al último intercambio, plegado en un solo bloque;
 *  - el último intercambio, abierto: desde la última respuesta del asistente hasta el
 *    final. Si en medio hay resultados de herramientas, van dentro, porque son parte de
 *    ese mismo intercambio.
 *
 * Sin JSX a propósito: es la parte con decisiones, y así se prueba sin navegador.
 */

export interface PromptPart {
  role: string;
  text: string;
  /** El mensaje no cupo entero en el presupuesto del historial. */
  trimmed?: boolean;
}

/** Un mensaje junto con su posición en la conversación original. */
export interface IndexedPart {
  part: PromptPart;
  index: number;
}

export interface ConversationView {
  system: IndexedPart[];
  /** El sistema se pliega salvo que sea lo único que hay. */
  collapseSystem: boolean;
  /** Lo anterior al último intercambio: se enseña plegado. */
  earlier: IndexedPart[];
  /** El último intercambio: se enseña abierto. */
  recent: IndexedPart[];
  /** Posición del último mensaje del usuario, que va resaltado. */
  highlight: number | null;
}

const SYSTEM_ROLES = new Set(['system', 'developer']);

export function splitConversation(parts: PromptPart[]): ConversationView {
  const indexed = parts.map((part, index) => ({ part, index }));
  const system = indexed.filter((x) => SYSTEM_ROLES.has(x.part.role));
  const rest = indexed.filter((x) => !SYSTEM_ROLES.has(x.part.role));
  const collapseSystem = parts.length > 1;

  let lastUser = -1;
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    if (rest[i]!.part.role === 'user') {
      lastUser = i;
      break;
    }
  }
  // Sin mensaje de usuario no hay «último intercambio» que destacar: se enseña todo.
  if (lastUser < 0) return { system, collapseSystem, earlier: [], recent: rest, highlight: null };

  // El intercambio empieza en la última respuesta del asistente anterior a esa pregunta.
  // En el primer turno no la hay, y entonces empieza en la propia pregunta.
  let start = lastUser;
  for (let i = lastUser - 1; i >= 0; i -= 1) {
    if (rest[i]!.part.role === 'assistant') {
      start = i;
      break;
    }
  }

  return {
    system,
    collapseSystem,
    earlier: rest.slice(0, start),
    recent: rest.slice(start),
    highlight: rest[lastUser]!.index,
  };
}
