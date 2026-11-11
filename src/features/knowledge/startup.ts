import { knowledgeList, knowledgeIndexText } from "./index.js";

// BarnDog-owned integration, independent from developer-authored Hook packages.
// Failure to retrieve an index must never block starting a coding session.
const timer = setTimeout(() => {
  console.error(
    "BarnDog knowledge index timed out; use barndog knowledge list.",
  );
  process.exit(0);
}, 5000);

try {
  const text = knowledgeIndexText(await knowledgeList(process.argv[3], true));
  if (text)
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
} catch {
  console.error(
    "BarnDog knowledge index is unavailable; use barndog knowledge list after reconnecting.",
  );
} finally {
  clearTimeout(timer);
}
