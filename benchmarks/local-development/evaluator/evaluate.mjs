import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { frontendTestEnvironment } from './environment.mjs';
import { runTaskApiAcceptance } from './api-acceptance.mjs';
import { runBrowserTaskAcceptance } from './browser-acceptance.mjs';

// Runs only in the explicitly prepared, immutable evaluator image. App stdout
// is captured here and is never forwarded as evaluator control output.
const require = createRequire('/opt/evaluator/package.json');
const { chromium } = require('playwright');
const taskId = process.argv[2];
const supported = new Set(['template-01', 'crud-01', 'modify-01', 'bug-01', 'multi-01']);
const report = { schemaVersion: 1, evaluatorVersion: '0.2.0', taskId, passed: false, checks: [], runtime: {}, externalRequests: [] };
const appRoot = '/work/app';
const backendRoot = `${appRoot}/backend`;
const frontendRoot = `${appRoot}/frontend`;
const environment = { ...process.env, PYTHONPATH: `${backendRoot}/src`, PYTHONPYCACHEPREFIX: '/scratch/pycache', DATABASE_URL: 'sqlite:////scratch/acceptance.sqlite', FORGER_APP_MANIFEST_PATH: `${appRoot}/manifest.json`, CORS_ORIGINS: 'http://127.0.0.1:5173', VITE_API_BASE_URL: 'http://127.0.0.1:8000' };
let backend; let frontend; let browser;

function start(command, args, cwd, commandEnvironment = environment) {
  const child = spawn(command, args, { cwd, env: commandEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output = (child.output + chunk).slice(-100000); });
  child.stderr.on('data', (chunk) => { child.output = (child.output + chunk).slice(-100000); });
  child.failure = null;
  child.on('error', (error) => { child.failure = error; });
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function command(commandName, args, cwd, commandEnvironment = environment) {
  const child = start(commandName, args, cwd, commandEnvironment);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${commandName} timeout`)); }, 90000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`${commandName} exited ${code}: ${child.output.slice(-12000)}`)); });
  });
}

async function check(name, action) {
  const started = Date.now();
  try {
    await action();
    report.checks.push({ name, passed: true, completedCheckGroups: 1, elapsedMs: Date.now() - started });
  } catch (error) {
    report.checks.push({ name, passed: false, completedCheckGroups: 0, error: error.message, elapsedMs: Date.now() - started });
    throw error;
  }
}

async function waitFor(url, child) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (child.failure || child.exitCode !== null) throw new Error(`Server failed: ${child.failure?.message ?? child.output}`);
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch { /* Poll bounded startup. */ }
    await delay(50);
  }
  throw new Error(`Server startup timeout: ${url}`);
}

async function request(method, route, body, expected = 200) {
  const response = await fetch(`http://127.0.0.1:8000${route}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, expected, `${method} ${route}: ${await response.clone().text()}`);
  return expected === 204 ? null : await response.json();
}

async function restartBackend() {
  await stop(backend);
  backend = start('python', ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], backendRoot);
  await waitFor('http://127.0.0.1:8000/api/health', backend);
}

async function browserAcceptance() {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { report.externalRequests.push(url.origin); await route.abort(); }
    else await route.continue();
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' });
  await runBrowserTaskAcceptance({ taskId, page });
  assert.deepEqual(errors, []); assert.deepEqual(report.externalRequests, []);
}

try {
  assert.ok(supported.has(taskId), 'Unknown executable task');
  // All supplied files/directories are read-only mounts. Only generated package
  // cache entries live in this writable directory; package contents stay read-only.
  await fs.mkdir(`${frontendRoot}/node_modules`);
  for (const entry of await fs.readdir('/opt/frontend/node_modules')) {
    await fs.symlink(`/opt/frontend/node_modules/${entry}`, `${frontendRoot}/node_modules/${entry}`);
  }
  report.runtime.node = process.version;
  report.runtime.pythonDependencies = await fs.readFile('/opt/python-dependencies.txt', 'utf8');
  report.runtime.frontendDependencies = JSON.parse(await fs.readFile('/opt/frontend-dependencies.json', 'utf8'));
  await check('backend_compile', async () => { await command('python', ['-m', 'compileall', '-q', `${backendRoot}/src`], backendRoot); });
  await check('frontend_build', async () => { await command('npm', ['run', 'build'], frontendRoot); });
  await check('backend_regression', async () => { await command('python', ['-m', 'pytest'], backendRoot); });
  await check('frontend_regression', async () => { await command('npm', ['run', 'test'], frontendRoot, frontendTestEnvironment(environment)); });
  // Backend regression tests receive temporary databases; acceptance uses a new
  // on-disk database, with a pre-existing record for the schema-evolution task.
  if (taskId === 'multi-01') {
    await command('python', ['-c', "import sqlite3; c=sqlite3.connect('/scratch/acceptance.sqlite'); c.execute('CREATE TABLE note (id INTEGER PRIMARY KEY, title VARCHAR NOT NULL)'); c.execute(\"INSERT INTO note VALUES (1001, 'Existing before archive')\"); c.commit()"], backendRoot);
  }
  await restartBackend();
  frontend = start('node', ['/opt/frontend/node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], frontendRoot);
  await waitFor('http://127.0.0.1:5173', frontend);
  await check('runtime_health', async () => {
    assert.deepEqual(await request('GET', '/api/health'), { status: 'ok', database: 'sqlite' });
    assert.deepEqual(await request('GET', '/health'), { status: 'ok', database: 'sqlite' });
    assert.equal((await request('GET', '/api/forger/context')).locale, 'es');
    if (taskId === 'multi-01') {
      const migrated = (await request('GET', '/api/notes')).find((note) => note.id === 1001);
      assert.equal(migrated?.title, 'Existing before archive'); assert.equal(migrated.archived, false);
      await request('DELETE', '/api/notes/1001', undefined, 204);
    }
  });
  await check('task_acceptance', () => runTaskApiAcceptance({ taskId, request, restartBackend }));
  await check('browser_acceptance', browserAcceptance);
  report.passed = report.checks.length === 7 && report.checks.every((entry) => entry.passed);
} catch (error) {
  report.error = error.message;
} finally {
  await browser?.close().catch(() => undefined);
  await stop(frontend); await stop(backend);
  console.log(`FORGER_EVALUATION=${JSON.stringify(report)}`);
  process.exitCode = report.passed ? 0 : 1;
}
