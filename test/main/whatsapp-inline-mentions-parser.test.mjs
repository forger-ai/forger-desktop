import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseAgentWakeMessage } = require('../../dist-electron/main/personal-agents/whatsapp-channel/parser.js');

for (const text of [
  'revisa como está el clima, y luego @kupita dime que poleron ponerme',
  'Dime qué polerón ponerme @KUPITA',
  'Primero revisa el clima.\nDespués @Kupita, recomienda ropa.',
  'Clima (@kupita): necesito una recomendación',
  '@kupita! revisa el clima',
  '@kupita; tarea',
  '@kupita! OFF',
  '@kupita? qué polerón uso',
  '@kupita. Revisa el clima',
  'Ayuda,@kupita: clima',
  'Revisa el clima @kupita.',
  'Dime @kupita qué hacer; @kupita incluye fuentes',
  'Conserva  Ａ  y e\u0301 antes de @ＫＵＰＩＴＡ; también  espacios.',
  'Aquí @kupita OFF',
  'Aquí @kupita ON',
  'Aquí @kupita CORREGIR MI ÚLTIMA otra cosa',
  'Aquí @kupita CORREGIR request-id otra cosa',
]) {
  test(`inline mention preserves the full original request: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(parseAgentWakeMessage(text, 'Kupita'), { kind: 'task', text });
  });
}

for (const text of [
  '@kupita', '  @kupita  ', '(@kupita)', '@kupita!', '@kupita?', '@kupita.',
  'hola Kupita', 'correo persona@kupita.com', 'correo persona@kupita',
  'https://example.org/@kupita consulta', 'https://@kupita consulta',
  'https://example.org?q=algo,@kupita consulta', 'example.org/ruta:@kupita consulta',
  'www.example.org: @kupita.com consulta',
  'mailto:@kupita consulta', 'tel:@kupita consulta', 'custom-scheme:@kupita consulta',
  'hola @@kupita consulta', 'hola @kupitabot consulta', 'hola @kupita2 consulta',
  'hola @kupita_casa consulta', 'hola @kupita-casa consulta', 'hola @kupita.com consulta',
  'hola @kupita/ruta consulta', 'hola @kupita@host consulta', 'hola x@kupita consulta',
  'hola ñ@kupita consulta', 'hola @kupita\u0301 consulta',
]) {
  test(`non-invocation does not wake the agent: ${JSON.stringify(text)}`, () => {
    assert.equal(parseAgentWakeMessage(text, 'Kupita'), null);
  });
}

test('prefix tasks and explicit controls preserve their existing grammar', () => {
  for (const prefix of ['Kupita', '@kupita', '@ＫＵＰＩＴＡ']) {
    assert.deepEqual(parseAgentWakeMessage(`${prefix}: consulta`, 'Kupita'), { kind: 'task', text: 'consulta' });
    assert.deepEqual(parseAgentWakeMessage(`${prefix} ON.`, 'Kupita'), { kind: 'on' });
    assert.deepEqual(parseAgentWakeMessage(`${prefix} OFF!`, 'Kupita'), { kind: 'off' });
    assert.deepEqual(parseAgentWakeMessage(`${prefix} CORREGIR MI ÚLTIMA cambio`, 'Kupita'), { kind: 'correct-own', text: 'cambio' });
    assert.deepEqual(parseAgentWakeMessage(`${prefix} CORREGIR req cambio`, 'Kupita'), { kind: 'correct', requestId: 'req', text: 'cambio' });
  }
  assert.equal(parseAgentWakeMessage('texto @kupita consulta', ' '), null);
  assert.deepEqual(parseAgentWakeMessage('Consulta @Casa Norte por favor', 'Casa Norte'), { kind: 'task', text: 'Consulta @Casa Norte por favor' });
  assert.deepEqual(parseAgentWakeMessage('Consulta @Kupita (Casa) por favor', 'Kupita (Casa)'), { kind: 'task', text: 'Consulta @Kupita (Casa) por favor' });
});
