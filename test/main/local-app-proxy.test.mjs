import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { createRequire } from 'node:module';
import { WebSocket, WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);

const listen = async (server) => await new Promise((resolve, reject) => {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve(`http://127.0.0.1:${address.port}`);
  });
  server.on('error', reject);
});

const close = async (server) => await new Promise((resolve) => server.close(resolve));

const websocketOpen = async (socket) => await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});

const websocketMessage = async (socket) => await new Promise((resolve, reject) => {
  socket.once('message', (data) => resolve(data.toString()));
  socket.once('error', reject);
});

test('local app proxy forwards HTTP API requests with the Forger prefix removed', async (t) => {
  const runtime = require('../../dist-electron/main/runtime/installed-app-runtime.js');
  const backendRequests = [];
  const frontendRequests = [];
  const backend = http.createServer((request, response) => {
    backendRequests.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, url: request.url }));
  });
  const frontend = http.createServer((request, response) => {
    frontendRequests.push(request.url);
    response.end('frontend');
  });
  const backendUrl = await listen(backend);
  const frontendUrl = await listen(frontend);
  const controller = runtime.createInstalledAppRuntimeController({ http, net });
  const proxy = await controller.createLocalAppProxy(backendUrl, frontendUrl);
  t.after(async () => {
    await controller.closeServer(proxy.server);
    await close(backend);
    await close(frontend);
  });

  const apiResponse = await fetch(`${proxy.url}/__forger_api/api/health`);
  const frontendResponse = await fetch(`${proxy.url}/api/health`);

  assert.deepEqual(await apiResponse.json(), { ok: true, url: '/api/health' });
  assert.equal(await frontendResponse.text(), 'frontend');
  assert.deepEqual(backendRequests, ['/api/health']);
  assert.deepEqual(frontendRequests, ['/api/health']);
});

test('local app proxy forwards websocket upgrades only through the Forger API prefix', async (t) => {
  const runtime = require('../../dist-electron/main/runtime/installed-app-runtime.js');
  const backend = http.createServer();
  const frontend = http.createServer();
  const websocketServer = new WebSocketServer({ noServer: true });
  const upgradedPaths = [];
  backend.on('upgrade', (request, socket, head) => {
    upgradedPaths.push(request.url);
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      client.on('message', (data) => client.send(`backend:${data.toString()}`));
    });
  });
  const backendUrl = await listen(backend);
  const frontendUrl = await listen(frontend);
  const controller = runtime.createInstalledAppRuntimeController({ http, net });
  const proxy = await controller.createLocalAppProxy(backendUrl, frontendUrl);
  t.after(async () => {
    websocketServer.close();
    await controller.closeServer(proxy.server);
    await close(backend);
    await close(frontend);
  });

  const socket = new WebSocket(`${proxy.url.replace('http:', 'ws:')}/__forger_api/api/voice/live-transcripts/ws?language=es`);
  await websocketOpen(socket);
  socket.send('pcm');
  assert.equal(await websocketMessage(socket), 'backend:pcm');
  socket.close();

  assert.deepEqual(upgradedPaths, ['/api/voice/live-transcripts/ws?language=es']);
});

test('local app proxy rejects websocket upgrades outside the Forger API prefix', async (t) => {
  const runtime = require('../../dist-electron/main/runtime/installed-app-runtime.js');
  const backend = http.createServer();
  const frontend = http.createServer();
  let backendUpgrades = 0;
  backend.on('upgrade', () => {
    backendUpgrades += 1;
  });
  const backendUrl = await listen(backend);
  const frontendUrl = await listen(frontend);
  const controller = runtime.createInstalledAppRuntimeController({ http, net });
  const proxy = await controller.createLocalAppProxy(backendUrl, frontendUrl);
  t.after(async () => {
    await controller.closeServer(proxy.server);
    await close(backend);
    await close(frontend);
  });

  const socket = new WebSocket(`${proxy.url.replace('http:', 'ws:')}/api/voice/live-transcripts/ws`);
  await assert.rejects(websocketOpen(socket));
  assert.equal(backendUpgrades, 0);
});
