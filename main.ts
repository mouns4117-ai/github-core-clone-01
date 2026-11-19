// Forge entrypoint: boots the one-process forge and keeps it up until the
// trial environment says the trial is over.
//
// When MAKEFUN_ENV_URL is present we are inside a trial. The forge then
// listens on a port the kernel picks for us, tells the environment which
// port that is, and keeps asking the environment whether the trial has
// finished. The moment the environment answers that it has, we shut the
// forge down and leave with a zero status.
//
// When MAKEFUN_ENV_URL is absent we are running by hand. The forge then
// listens on a fixed local port and stays up until it is interrupted.

import { createApp } from "./app.ts";
import type { Server } from "node:http";

// Port used for hand runs, when no trial environment tells us otherwise.
const HAND_RUN_PORT = 8199;

// How long to wait between "is the trial done yet" questions.
const DONE_POLL_GAP_MS = 1000;

// How often to retry telling the environment our port, and for how long.
const REGISTER_RETRY_GAP_MS = 500;
const REGISTER_MAX_TRIES = 60;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

// The trial environment's origin, without a trailing slash, or undefined
// when we are not inside a trial at all.
function environmentOrigin(): string | undefined {
  const rawValue = process.env.MAKEFUN_ENV_URL;
  if (rawValue === undefined) {
    return undefined;
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

// Tell the trial environment which port the forge ended up listening on.
// The environment may not be ready the first time we ask, so keep trying
// for a while before giving up.
async function announceListeningPort(origin: string, portNumber: number): Promise<boolean> {
  for (let attempt = 1; attempt <= REGISTER_MAX_TRIES; attempt += 1) {
    try {
      const reply = await fetch(`${origin}/register`, {
        body: JSON.stringify({ port: portNumber }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (reply.ok) {
        return true;
      }
    } catch {
      // The environment is not answering yet; the retry below covers it.
    }
    await wait(REGISTER_RETRY_GAP_MS);
  }
  return false;
}

// Keep asking the environment whether the trial is finished, and only come
// back once it answers yes. A single failed question is not fatal: the
// next one usually goes through.
async function waitForTrialToFinish(origin: string): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(`${origin}/done`, { method: "GET" });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) {
          return;
        }
      }
    } catch {
      // A missed poll changes nothing; ask again after the gap.
    }
    await wait(DONE_POLL_GAP_MS);
  }
}

// The port for a hand run: an argument first, then FORGE_PORT, then the
// fallback above. Anything unusable falls back to the fallback.
function handRunPort(): number {
  const candidates = [process.argv[2], process.env.FORGE_PORT];
  for (const candidate of candidates) {
    if (candidate === undefined) {
      continue;
    }
    const parsed = Number.parseInt(candidate, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return HAND_RUN_PORT;
}

async function boot(): Promise<number> {
  const forge: Server = createApp();
  const origin = environmentOrigin();

  const stopGracefully = (): void => {
    forge.close(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", stopGracefully);
  process.once("SIGTERM", stopGracefully);

  if (origin === undefined) {
    const chosen = handRunPort();
    await new Promise<void>((resolve, reject) => {
      forge.once("error", reject);
      forge.listen(chosen, "127.0.0.1", () => resolve());
    });
    process.stdout.write(`forge up for hand use at http://127.0.0.1:${chosen}\n`);
    // Park here on purpose: the listening server keeps this process alive
    // until an interrupt arrives, which the handler above answers.
    await new Promise(() => undefined);
  }

  const assigned: number = await new Promise<number>((resolve, reject) => {
    forge.once("error", reject);
    forge.listen(0, "0.0.0.0", () => {
      const bound = forge.address();
      if (bound !== null && typeof bound === "object") {
        resolve(bound.port);
      } else {
        reject(new Error("the forge bound a port it cannot report"));
      }
    });
  });
  process.stdout.write(`forge listening on port ${assigned}\n`);

  const announced = await announceListeningPort(origin, assigned);
  if (!announced) {
    process.stderr.write("forge could not announce its port to the trial environment\n");
    forge.close();
    return 1;
  }

  await waitForTrialToFinish(origin);
  forge.close();
  return 0;
}

boot().then(
  (exitCode) => process.exit(exitCode),
  (failure: unknown) => {
    const detail = failure instanceof Error ? failure.message : String(failure);
    process.stderr.write(`forge failed to start: ${detail}\n`);
    process.exit(1);
  },
);
