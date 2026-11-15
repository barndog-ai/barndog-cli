import { bold, clean, dim, hint, json, ok, table, warn } from "../ui/format.js";
import { runSelection } from "../ui/selection.js";
import { type Command } from "commander";
import { type CommandContext } from "./context.js";
import { commandHelpers } from "./helpers.js";

/** When coding tools see a knowledge document. */
function knowledgeListing(listedAtStart: boolean, accessMode: string) {
  if (listedAtStart) {
    return ok("every session");
  }

  return accessMode === "always" ? dim("off") : dim("on demand");
}

/** `barndog knowledge`: reading shared knowledge and its session-start listing. */
export function registerKnowledge(program: Command, context: CommandContext) {
  const { write } = commandHelpers(context);

  const knowledge = program
    .command("knowledge")
    .description("Read your organization's shared knowledge documents");

  knowledge
    .command("list")
    .description("List knowledge documents and when coding tools see them")
    .option("--always", "Only documents listed at every session start")
    .action(async (options: { always?: boolean }) => {
      const docs = await context.knowledgeList(options.always);
      if (context.mode.json) {
        return context.write(json(docs));
      }

      const problems = await context.knowledgeProblems().catch(() => []);
      for (const problem of problems) {
        context.write(`${warn("!")} ${problem.path}: ${problem.reason}`);
      }

      if (!docs.length) {
        return context.write(dim("No knowledge documents yet."));
      }

      for (const line of table(
        docs.map((doc) => [
          bold(clean(doc.name)),
          knowledgeListing(doc.listedAtStart, doc.accessMode),
          dim(clean(doc.description)),
        ]),
        { header: ["Name", "Listed", "Description"] },
      )) {
        context.write(line);
      }

      context.write("");
      if (docs.some((d) => d.accessMode === "always" && !d.listedAtStart)) {
        context.write(
          hint("barndog knowledge enable", "Tip") +
            dim("  to list these at session start again"),
        );
      }

      context.write(
        hint("barndog knowledge get <name>", "Tip") + dim("  to read one"),
      );
    });

  knowledge
    .command("get <name>")
    .description("Print a knowledge document")
    .action(async (name: string) => {
      const result = await context.knowledgeGet(name);
      if (context.mode.json) {
        return context.write(json(result));
      }

      write(result.version.content.markdown);
    });

  for (const action of ["enable", "disable"] as const) {
    knowledge
      .command(action)
      .description(
        action === "enable"
          ? "Tell coding tools at session start which knowledge documents exist"
          : "Stop listing knowledge documents at session start",
      )
      .action(async () => {
        await runSelection(context, () =>
          context.setKnowledge(action === "enable"),
        );

        if (context.mode.json) {
          return;
        }

        context.write(
          action === "enable"
            ? `${ok("✔")} Coding tools now see the list of knowledge documents when a session starts.`
            : `${ok("✔")} Knowledge documents are no longer listed at session start.`,
        );
      });
  }
}
