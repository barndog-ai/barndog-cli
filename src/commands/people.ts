import {
  bold,
  clean,
  dim,
  hint,
  json,
  originLabel,
  table,
} from "../ui/format.js";
import { type Command } from "commander";
import { type CommandContext } from "./context.js";

/** `barndog people`: coworkers and the personal assets they share. */
export function registerPeople(program: Command, context: CommandContext) {
  const people = program
    .command("people")
    .description("Find coworkers and the personal assets they share");

  people
    .command("list")
    .description("List people in your organization")
    .option("--search <query>", "Search names or handles")
    .action(async (options: { search?: string }) => {
      const rows = await context.developers(options.search);
      if (context.mode.json) {
        return context.write(json(rows));
      }

      if (!rows.length) {
        return context.write(dim("No matching people."));
      }

      for (const line of table(
        rows.map((person) => [
          bold(clean(person.name)),
          dim(`@${clean(person.slug)}`),
        ]),
        { header: ["Name", "Handle"] },
      )) {
        context.write(line);
      }

      context.write("");
      context.write(
        hint("barndog people show <handle>", "Tip") +
          dim("  to see what someone shares"),
      );
    });

  people
    .command("show <handle>")
    .description("List a person's shared assets")
    .option("--search <query>", "Filter asset names")
    .action(async (handle: string, options: { search?: string }) => {
      const result = await context.developerAssets(handle, options.search);
      if (context.mode.json) {
        return context.write(json(result));
      }

      context.write(
        `${bold(clean(result.developer.name))} ${dim(`@${result.developer.slug}`)}`,
      );

      context.write("");
      if (!result.assets.length) {
        return context.write(dim("  Nothing shared yet."));
      }

      for (const line of table(
        result.assets.map((asset) => [
          dim(asset.kind),
          bold(clean(asset.name)),
          originLabel(asset.origin),
        ]),
        { header: ["Kind", "Name", "Origin"] },
      )) {
        context.write(line);
      }
    });
}
