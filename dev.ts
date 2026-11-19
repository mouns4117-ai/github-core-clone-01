// Local runner: start the forge on a fixed port without an env to register with.
// Not part of the trial lifecycle (main.ts is); used for grade-local runs.
//
//   MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types dev.ts [port]

import { createApp } from './app.ts';

const port = Number(process.argv[2] ?? process.env.PORT ?? 8123);
const server = createApp();
server.listen(port, () => {
  process.stdout.write(`[dev] forge listening on http://127.0.0.1:${port}\n`);
  process.stdout.write(`[dev] MAKEFUN_SHOP_TOKEN=${process.env.MAKEFUN_SHOP_TOKEN ? '(set)' : '(unset: any non-empty token accepted)'}\n`);
});
