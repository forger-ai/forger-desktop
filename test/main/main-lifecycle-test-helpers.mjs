import fs from 'node:fs/promises';
import path from 'node:path';

export const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

export const withProcessPlatform = (platform, callback) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
  try {
    return callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, 'platform', descriptor);
    }
  }
};

export const waitForMainLifecycle = async (predicate = () => true) => {
  for (let index = 0; index < 100; index += 1) {
    if (index > 0 && await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!await predicate()) {
    throw new Error('main_lifecycle_wait_timeout');
  }
};

export const readDesktopLogEvents = async (metadataRoot) => {
  const raw = await fs.readFile(path.join(metadataRoot, 'logs', 'forger-desktop.jsonl'), 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

export const createServiceClass = (name, calls, extraFactory = () => ({})) => class TestLifecycleService {
  constructor(options = {}) {
    this.name = name;
    this.options = options;
    this.started = false;
    calls.constructed.push({ name, options, service: this });
    Object.assign(this, extraFactory(options, this));
  }

  async start() {
    this.started = true;
    calls.started.push(name);
  }

  async stop() {
    this.started = false;
    calls.stopped.push(name);
  }

  dispose() {
    calls.disposed.push(name);
  }

  async initialize() {
    calls.initialized.push(name);
  }

  async load() {
    calls.loaded.push(name);
    return {};
  }

  async getSummary() {
    return {};
  }

  getPublicRegistration() {
    return {};
  }

  async requestPermission() {
    return null;
  }

  async requestExternalPermission() {
    return null;
  }

  createSession() {
    return 'session-token';
  }

  releaseSession() {}

  async listenMcps() {
    return [];
  }

  releaseMcps() {}

  appendExternalProgress() {}

  environmentForApp() {
    return {};
  }

  publishAgentEvent() {}
};

export const createStartupBrowserWindowClass = (calls) => class StartupBrowserWindowDouble {
  static getAllWindows() {
    return [];
  }

  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.executedScripts = [];
    this.loadUrls = [];
    this.webContents = {
      executeJavaScript: async (script) => {
        this.executedScripts.push(script);
      },
    };
    calls.startupWindows.push(this);
  }

  async loadURL(url) {
    this.loadUrls.push(url);
  }

  close() {
    this.destroyed = true;
    calls.closedStartupWindows.push(this);
  }

  isDestroyed() {
    return this.destroyed;
  }
};
