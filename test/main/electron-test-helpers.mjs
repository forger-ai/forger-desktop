import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

export const clearDistModule = (relativePath) => {
  const resolved = require.resolve(`../../dist-electron/${relativePath}`);
  delete require.cache[resolved];
  return resolved;
};

export const withMockedElectron = async (electronMock, callback) => {
  const originalLoad = Module._load;
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') {
      return electronMock;
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };

  try {
    return await callback(require);
  } finally {
    Module._load = originalLoad;
  }
};

export const createPreloadElectronMock = ({ invokeImpl, sendImpl } = {}) => {
  const exposed = new Map();
  const invokeCalls = [];
  const sendCalls = [];
  const listeners = new Map();
  const removedListeners = [];

  return {
    exposed,
    invokeCalls,
    sendCalls,
    listeners,
    removedListeners,
    electronMock: {
      contextBridge: {
        exposeInMainWorld(name, api) {
          exposed.set(name, api);
        },
      },
      ipcRenderer: {
        invoke(channel, ...args) {
          invokeCalls.push([channel, ...args]);
          if (invokeImpl) {
            return invokeImpl(channel, ...args);
          }
          return Promise.resolve({ channel, args });
        },
        send(channel, ...args) {
          sendCalls.push([channel, ...args]);
          if (sendImpl) {
            return sendImpl(channel, ...args);
          }
          return undefined;
        },
        on(channel, listener) {
          listeners.set(channel, listener);
        },
        removeListener(channel, listener) {
          removedListeners.push([channel, listener]);
          if (listeners.get(channel) === listener) {
            listeners.delete(channel);
          }
        },
      },
    },
  };
};

export const requireExposedApi = (exposed, name) => {
  const api = exposed.get(name);
  if (!api) {
    throw new Error(`missing_exposed_api:${name}`);
  }
  return api;
};

export const createPreloadWindowMock = ({ href = 'https://app.local/?forgerLocale=es-CL' } = {}) => {
  const listeners = new Map();
  const location = new URL(href);
  return {
    listeners,
    window: {
      location,
      addEventListener(event, listener) {
        listeners.set(event, listener);
      },
      removeEventListener(event, listener) {
        if (listeners.get(event) === listener) {
          listeners.delete(event);
        }
      },
    },
  };
};

export const createPreloadDocumentMock = () => {
  const elements = [];
  const documentElement = {
    children: [],
    append(element) {
      this.children.push(element);
      elements.push(element);
    },
  };

  return {
    document: {
      documentElement,
      createElement(tagName) {
        const element = {
          tagName,
          children: [],
          dataset: {},
          style: { cssText: '' },
          textContent: '',
          type: '',
          listeners: new Map(),
          append(...children) {
            this.children.push(...children);
          },
          addEventListener(event, listener) {
            this.listeners.set(event, listener);
          },
          remove() {
            const index = elements.indexOf(element);
            if (index >= 0) {
              elements.splice(index, 1);
            }
            const childIndex = documentElement.children.indexOf(element);
            if (childIndex >= 0) {
              documentElement.children.splice(childIndex, 1);
            }
          },
        };
        return element;
      },
      querySelector(selector) {
        if (selector === '[data-forger-permission-overlay="true"]') {
          return elements.find((element) => element.dataset?.forgerPermissionOverlay === 'true') ?? null;
        }
        return null;
      },
    },
  };
};

export const withMockedBrowserGlobals = async (globals, callback) => {
  const previous = new Map();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.prototype.hasOwnProperty.call(globalThis, name) ? globalThis[name] : undefined);
    globalThis[name] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [name, value] of previous.entries()) {
      if (value === undefined) {
        delete globalThis[name];
      } else {
        globalThis[name] = value;
      }
    }
  }
};

export const createIpcMainRecorder = () => {
  const handlers = new Map();
  return {
    handlers,
    ipcMain: {
      handle(channel, handler) {
        if (handlers.has(channel)) {
          throw new Error(`duplicate_handler:${channel}`);
        }
        handlers.set(channel, handler);
      },
    },
  };
};

export const createElectronAppMock = () => {
  const listeners = new Map();
  return {
    listeners,
    focusedWith: [],
    protocolRegistrations: [],
    quitCalls: 0,
    focus(input) {
      this.focusedWith.push(input);
    },
    getPath(name) {
      return `/tmp/forger-${name}`;
    },
    getVersion() {
      return '0.0.0-test';
    },
    on(event, listener) {
      listeners.set(event, listener);
    },
    quit() {
      this.quitCalls += 1;
    },
    requestSingleInstanceLock() {
      return true;
    },
    setAsDefaultProtocolClient(...args) {
      this.protocolRegistrations.push(args);
      return true;
    },
    whenReady() {
      return Promise.resolve();
    },
  };
};
