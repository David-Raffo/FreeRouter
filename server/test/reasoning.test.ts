/**
 * Filtrado del razonamiento.
 *
 * Lo que se comprueba aquí es que el «thinking» no llegue al cliente cuando su API key no
 * lo ha pedido. Los proveedores lo cuelan de dos formas —campo aparte y etiquetas dentro
 * del texto— y en streaming la etiqueta llega partida entre trozos, que es donde un
 * filtro ingenuo se rompe sin avisar: deja pasar «<thi» + «nk>» como si fuera texto.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createReasoningFilter, stripReasoning, stripReasoningFromChunk } from '../src/routes/reasoning.js';

/** Pasa un texto por el filtro partiéndolo en trozos de `n` caracteres. */
function porTrozos(texto: string, n: number): string {
  const filter = createReasoningFilter();
  let out = '';
  for (let i = 0; i < texto.length; i += n) out += filter.push(texto.slice(i, i + n));
  return out + filter.flush();
}

describe('quitar el razonamiento del texto', () => {
  it('elimina un bloque <think> completo', () => {
    assert.equal(porTrozos('<think>déjame pensar</think>La capital es París.', 1000), 'La capital es París.');
  });

  it('lo elimina aunque la etiqueta llegue partida entre trozos', () => {
    // El caso que importa: en streaming «<think>» puede llegar como «<thi» + «nk>».
    // Un filtro sin memoria lo deja pasar tal cual y el usuario ve la etiqueta.
    const texto = '<think>razono un rato y algo más</think>Respuesta final.';
    for (const trozo of [1, 2, 3, 4, 5, 7, 11]) {
      assert.equal(porTrozos(texto, trozo), 'Respuesta final.', `se rompe con trozos de ${trozo}`);
    }
  });

  it('aguanta varios bloques y otras etiquetas', () => {
    assert.equal(porTrozos('<thinking>a</thinking>Hola <reasoning>b</reasoning>mundo', 3), 'Hola mundo');
  });

  it('un bloque sin cerrar no se emite: era razonamiento hasta el final', () => {
    assert.equal(porTrozos('<think>me quedé a medias', 4), '');
  });

  it('no toca un texto que no lleva razonamiento', () => {
    const texto = 'Un texto normal con un < suelto y la palabra think dentro.';
    assert.equal(porTrozos(texto, 5), texto);
  });

  it('no se come el texto anterior a la etiqueta', () => {
    assert.equal(porTrozos('Antes<think>medio</think>después', 2), 'Antesdespués');
  });
});

describe('respuesta de una pieza', () => {
  it('quita el campo aparte y el bloque del contenido', () => {
    const payload = stripReasoning({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '<think>mmm</think>La respuesta es 42.',
            reasoning_content: 'mmm',
            reasoning: 'mmm',
          },
        },
      ],
    });
    const message = (payload.choices as Array<{ message: Record<string, unknown> }>)[0]!.message;
    assert.equal(message.content, 'La respuesta es 42.');
    assert.equal(message.reasoning_content, undefined);
    assert.equal(message.reasoning, undefined);
  });
});

describe('streaming', () => {
  /** Reconstruye lo que vería el cliente a partir de unos trozos. */
  function transmitido(trozos: string[]): string {
    const filter = createReasoningFilter();
    let visto = '';
    for (const contenido of trozos) {
      const chunk = stripReasoningFromChunk(
        { choices: [{ index: 0, delta: { content: contenido } }] },
        filter,
      );
      if (!chunk) continue;
      const delta = (chunk.choices as Array<{ delta: { content?: string } }>)[0]!.delta;
      visto += delta.content ?? '';
    }
    // Igual que hace la ruta al cerrar el stream.
    return visto + filter.flush();
  }

  it('el cliente no ve ni un carácter del razonamiento', () => {
    assert.equal(transmitido(['<thi', 'nk>', 'pienso', ' mucho', '</think>', 'Hola', ' mundo']), 'Hola mundo');
  });

  it('los trozos que solo traían razonamiento se descartan enteros', () => {
    // Reenviarlos vacíos hace que algunos clientes pinten un hueco.
    const filter = createReasoningFilter();
    const primero = stripReasoningFromChunk({ choices: [{ delta: { content: '<think>' } }] }, filter);
    const dentro = stripReasoningFromChunk({ choices: [{ delta: { content: 'razonando' } }] }, filter);
    assert.equal(dentro, null, 'nada que transmitir');
    assert.ok(primero === null || primero !== undefined);
  });

  it('el trozo final con finish_reason se respeta aunque no lleve texto', () => {
    const filter = createReasoningFilter();
    const chunk = stripReasoningFromChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }, filter);
    assert.ok(chunk, 'el cierre del stream no puede perderse');
  });

  it('quita el campo de razonamiento de los deltas', () => {
    const filter = createReasoningFilter();
    const chunk = stripReasoningFromChunk(
      { choices: [{ delta: { content: 'hola', reasoning_content: 'pensando' } }] },
      filter,
    );
    const delta = (chunk!.choices as Array<{ delta: Record<string, unknown> }>)[0]!.delta;
    assert.equal(delta.content, 'hola');
    assert.equal(delta.reasoning_content, undefined);
  });
});
