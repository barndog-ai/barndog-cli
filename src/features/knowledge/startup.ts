import { knowledgeList, knowledgeIndexText } from "./index.js";

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

try {
  const text = knowledgeIndexText(await knowledgeList(true, process.argv[3]));
  if (text) {
    console.log(
      JSON.stringify(
        process.argv[2] === "cursor"
          ? { additional_context: text }
          : {
              hookSpecificOutput: {
                hookEventName: "SessionStart",
                additionalContext: text,
              },
            },
      ),
    );
  }
} catch {
  console.error(
    "BarnDog knowledge index is unavailable; use barndog knowledge list after reconnecting.",
  );
} finally {
  clearTimeout(timer);
}
