import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface ConsoleErrorEntry {
  text: string;
  url: string;
  source: 'console' | 'pageerror';
}

export interface NetworkFailureEntry {
  url: string;
  status: number | null;
  failure: string | null;
}

export interface SmokeFixtures {
  consoleErrors: ConsoleErrorEntry[];
  networkFailures: NetworkFailureEntry[];
  /**
   * Absolute path to the Archon repo this spec runs against. Resolves to the
   * repo root (three levels up from this file). The smoke spec registers this
   * path via the in-app "Add project" flow.
   */
  tmpRepoPath: string;
}

/**
 * Decide whether a captured console error or pageerror is dev-tooling noise.
 * Vite HMR, React DevTools nudges, and source-map warnings are dropped; only
 * application-code errors survive to fail the spec.
 */
function shouldIgnoreConsoleEntry(text: string, url: string): boolean {
  const lowered = text.toLowerCase();
  if (
    lowered.includes('react devtools') ||
    lowered.includes('download the react devtools') ||
    lowered.includes('[hmr]') ||
    lowered.includes('[vite]') ||
    lowered.includes('source map error')
  ) {
    return true;
  }
  if (url.includes('/@vite/') || url.includes('/__vite_ping')) {
    return true;
  }
  return false;
}

function isSameOrigin(url: string, baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const u = new URL(url);
    const b = new URL(baseURL);
    return u.host === b.host;
  } catch {
    return false;
  }
}

function attachListeners(
  page: Page,
  consoleErrors: ConsoleErrorEntry[],
  networkFailures: NetworkFailureEntry[],
  baseURL: string | undefined
): void {
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const url = msg.location().url;
    if (shouldIgnoreConsoleEntry(text, url)) return;
    consoleErrors.push({ text, url, source: 'console' });
  });

  page.on('pageerror', err => {
    consoleErrors.push({
      text: err.message,
      url: err.stack?.split('\n')[1]?.trim() ?? '',
      source: 'pageerror',
    });
  });

  page.on('response', response => {
    const status = response.status();
    if (status < 500) return;
    const url = response.url();
    if (!isSameOrigin(url, baseURL)) return;
    if (!url.includes('/api/')) return;
    networkFailures.push({ url, status, failure: null });
  });

  page.on('requestfailed', request => {
    const url = request.url();
    if (!isSameOrigin(url, baseURL)) return;
    if (!url.includes('/api/')) return;
    const failure = request.failure();
    const errorText = failure?.errorText ?? 'unknown';
    // net::ERR_ABORTED fires when the browser cancels an in-flight request
    // (route change, EventSource close, beforeunload). These are not server
    // failures, just navigation cleanup.
    if (errorText === 'net::ERR_ABORTED') return;
    // SSE/stream endpoints are long-lived; any cancellation on them is the
    // client closing the EventSource, not a server-side fault.
    if (url.includes('/api/stream/')) return;
    networkFailures.push({
      url,
      status: null,
      failure: errorText,
    });
  });
}

interface SmokeListenerState {
  consoleErrors: ConsoleErrorEntry[];
  networkFailures: NetworkFailureEntry[];
}

/**
 * Worker-internal fixture that owns the listener attachment and the underlying
 * arrays. Public `consoleErrors` and `networkFailures` fixtures read from it
 * so both spec assertions and the post-test validators see the same data.
 */
const testWithSmoke = base.extend<{ smokeListeners: SmokeListenerState } & SmokeFixtures>({
  smokeListeners: async ({ page, baseURL }, runTest) => {
    const state: SmokeListenerState = { consoleErrors: [], networkFailures: [] };
    attachListeners(page, state.consoleErrors, state.networkFailures, baseURL);
    await runTest(state);
  },

  consoleErrors: async ({ smokeListeners }, runTest) => {
    await runTest(smokeListeners.consoleErrors);
    if (smokeListeners.consoleErrors.length > 0) {
      const summary = smokeListeners.consoleErrors
        .map(e => `[${e.source}] ${e.text}${e.url ? ` (${e.url})` : ''}`)
        .join('\n');
      throw new Error(
        `Captured ${String(smokeListeners.consoleErrors.length)} console error(s):\n${summary}`
      );
    }
  },

  networkFailures: async ({ smokeListeners }, runTest) => {
    await runTest(smokeListeners.networkFailures);
    if (smokeListeners.networkFailures.length > 0) {
      const summary = smokeListeners.networkFailures
        .map(f => `${String(f.status ?? f.failure ?? 'failed')} ${f.url}`)
        .join('\n');
      throw new Error(
        `Captured ${String(smokeListeners.networkFailures.length)} network failure(s):\n${summary}`
      );
    }
  },

  // eslint-disable-next-line no-empty-pattern
  tmpRepoPath: async ({}, runTest) => {
    const repoRoot = path.resolve(here, '..', '..', '..');
    await runTest(repoRoot);
  },
});

export const test = testWithSmoke;
export { expect };
