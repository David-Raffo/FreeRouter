/**
 * Qué se enseña abierto al desplegar una petición en el historial.
 *
 * La lógica vive en el panel (`web/src/prompt-view.ts`) pero es pura, así que se prueba
 * desde aquí, donde está el ejecutor de pruebas.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitConversation, type PromptPart } from '../../web/src/prompt-view.js';

const msg = (role: string, text = role): PromptPart => ({ role, text });
const roles = (xs: Array<{ part: PromptPart }>): string[] => xs.map((x) => x.part.text);

describe('conversación en el historial', () => {
  it('abre solo el último intercambio y pliega lo anterior', () => {
    // El caso del chatbot: veinte turnos delante y lo que se quiere ver es el final.
    const view = splitConversation([
      msg('system'),
      msg('user', 'u1'),
      msg('assistant', 'a1'),
      msg('user', 'u2'),
      msg('assistant', 'a2'),
      msg('user', 'u3'),
    ]);

    assert.deepEqual(roles(view.recent), ['a2', 'u3'], 'la última respuesta y la última pregunta');
    assert.deepEqual(roles(view.earlier), ['u1', 'a1', 'u2'], 'lo anterior, plegado');
    assert.deepEqual(roles(view.system), ['system']);
    assert.equal(view.highlight, 5, 'la última pregunta va resaltada');
  });

  it('en el primer turno no hay nada que plegar', () => {
    const view = splitConversation([msg('system'), msg('user', 'hola')]);
    assert.deepEqual(roles(view.recent), ['hola']);
    assert.deepEqual(view.earlier, []);
  });

  it('los resultados de herramientas del último intercambio quedan a la vista', () => {
    // Son parte de ese mismo intercambio: la respuesta pidió la herramienta, llegó el
    // resultado y el usuario siguió. Plegarlos dejaría el intercambio sin sentido.
    const view = splitConversation([
      msg('user', 'u1'),
      msg('assistant', 'pide-herramienta'),
      msg('tool', 'resultado'),
      msg('user', 'u2'),
    ]);
    assert.deepEqual(roles(view.recent), ['pide-herramienta', 'resultado', 'u2']);
    assert.deepEqual(roles(view.earlier), ['u1']);
  });

  it('sin ningún mensaje de usuario se enseña todo', () => {
    const view = splitConversation([msg('system'), msg('assistant', 'a1')]);
    assert.deepEqual(roles(view.recent), ['a1']);
    assert.equal(view.highlight, null);
  });

  it('el sistema solo se pliega si hay algo más que enseñar', () => {
    assert.equal(splitConversation([msg('system')]).collapseSystem, false);
    assert.equal(splitConversation([msg('system'), msg('user')]).collapseSystem, true);
  });

  it('no se pierde ni un mensaje al repartir', () => {
    const parts = [
      msg('system'),
      msg('user', 'u1'),
      msg('assistant', 'a1'),
      msg('tool', 't1'),
      msg('user', 'u2'),
      msg('assistant', 'a2'),
      msg('user', 'u3'),
    ];
    const view = splitConversation(parts);
    const vistos = [...view.system, ...view.earlier, ...view.recent].map((x) => x.index).sort((a, b) => a - b);
    assert.deepEqual(vistos, parts.map((_, i) => i));
  });
});
