import { homedir } from "node:os";

import { refreshUpdateCheck } from "../features/update-check/index.js";

// Started detached after a command, with the home that command used. It can
// never fail that command: a missed check is retried after the next one.
try {
  await refreshUpdateCheck({
    home: process.argv[2] ?? homedir(),
    cwd: process.cwd(),
    env: { ...process.env },
    platform: process.platform,
  });
} catch {
  // Nothing to report to; the cached answer stays as it was.
}
