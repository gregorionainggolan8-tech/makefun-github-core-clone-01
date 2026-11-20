// main.ts — the entrypoint and the trial lifecycle: start the forge on an
// ephemeral port, tell the suite where it listens, then wait until the suite
// says the trial is over and exit cleanly.
//
// The dance, in order:
//   1. MAKEFUN_ENV_URL points at the suite. Without it there is no trial to join.
//   2. Listen on port 0 and let the kernel pick a free one. Port 8080 belongs to
//      the suite and is never touched.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register so the suite can dial the forge.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}, then shut
//      the server down and exit 0. The process never leaves early on its own.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set, so there is no suite to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * Keep POSTing the bound port until the suite takes it. A 200 means it is
 * registered; a 409 means a first registration already won and this process
 * simply waits along. Anything else is retried — the suite may still be booting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register was refused with HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register was refused')) throw error;
    }
    await sleep(backoff(attempt));
  }
}

/** Poll the suite until it reports the trial finished. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The suite is not answering yet: keep polling.
    }
    await sleep(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the forge did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[forge] registered; waiting for the suite to finish\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[forge] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
