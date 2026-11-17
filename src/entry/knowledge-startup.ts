import { homedir } from "node:os";
import { adapters, isHarness } from "../harnesses/registry.js";
import {
  knowledgeList,
  knowledgeIndexText,
} from "../features/knowledge/index.js";

/** Keep knowledge delivery from blocking harness startup beyond five seconds. */
const STARTUP_KNOWLEDGE_TIMEOUT_MS = 5000;

// BarnDog-owned integration, independent from developer-authored Hook packages.
// Failure to retrieve an index must never block starting a coding session.
const timer = setTimeout(() => {
  console.error(
    "BarnDog knowledge index timed out; use barndog knowledge list.",
  );

  process.exit(0);
}, STARTUP_KNOWLEDGE_TIMEOUT_MS);

const runtime = {
  home: process.argv[3] ?? homedir(),
  cwd: process.cwd(),
  env: { ...process.env },
  platform: process.platform,
};

try {
  const text = knowledgeIndexText(await knowledgeList(true, runtime));

  const harness = process.argv[2];
  if (text && isHarness(harness)) {
    // A plugin (OpenCode's) adds the plain text itself; a hook prints the tool's JSON.
    const { hooks } = adapters[harness];
    console.log(hooks ? JSON.stringify(hooks.sessionContext(text)) : text);
  }
} catch {
  console.error(
    "BarnDog knowledge index is unavailable; use barndog knowledge list after reconnecting.",
  );
} finally {
  clearTimeout(timer);
}
