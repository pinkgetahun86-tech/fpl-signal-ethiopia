import { setAuthTokenGetter, setBaseUrl } from '@workspace/api-client-react';

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { user?: { first_name?: string; username?: string } };
  ready: () => void;
  expand: () => void;
  close?: () => void;
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
  onEvent?: (event: string, callback: () => void) => void;
  offEvent?: (event: string, callback: () => void) => void;
  BackButton?: { show: () => void; hide: () => void; onClick: (cb: () => void) => void; offClick: (cb: () => void) => void };
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
}

declare global {
  interface Window { Telegram?: { WebApp?: TelegramWebApp }; }
}

export function getTelegramWebApp(): TelegramWebApp | null {
  return typeof window !== 'undefined' ? window.Telegram?.WebApp ?? null : null;
}

export function configureTelegramAuth() {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();
  setBaseUrl(apiBaseUrl || null);
  setAuthTokenGetter(() => getTelegramWebApp()?.initData || null);
}

export function prepareTelegramApp() {
  const app = getTelegramWebApp();
  if (!app) return undefined;
  app.ready();
  app.expand();
  const applyTheme = () => {
    document.documentElement.classList.toggle('dark', app.colorScheme === 'dark');
  };
  applyTheme();
  app.onEvent?.('themeChanged', applyTheme);
  return () => app.offEvent?.('themeChanged', applyTheme);
}