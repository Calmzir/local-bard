import type { LocalBardAPI } from '../shared/types';

declare global {
  interface Window {
    bard: LocalBardAPI;
  }
}

export {};
