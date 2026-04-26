/// <reference types="vite/client" />

import type { ForgerDesktopApi } from '../shared/types';

declare global {
  interface Window {
    forger: ForgerDesktopApi;
  }
}

export {};
