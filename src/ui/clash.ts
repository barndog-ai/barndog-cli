import select from "@inquirer/select";
import {
  originLabel,
  validInstalledName,
  type Clash,
  type ClashChoice,
} from "../features/environment/names.js";
import { bold, dim, fields, warn } from "./format.js";
import { promptTheme } from "./theme.js";

/** Asks once per clash; the sync persists the answer. */
export async function promptClash(clash: Clash): Promise<ClashChoice> {
  const noun = clash.kind === "skill" ? "Skills" : "MCP servers";
  console.log("");
  console.log(`${warn("!")} Two ${noun} want the name ${bold(clash.name)}`);
  for (const line of fields(
    [
      ["Installed", originLabel(clash.installed.origin)],
      ["New", originLabel(clash.incoming.origin)],
    ],
    2,
  ))
    console.log(line);
  console.log("");
  const choices: { name: string; value: ClashChoice; description?: string }[] =
    [];
  if (
    clash.incoming.renamable !== false &&
    validInstalledName(clash.incomingRename)
  )
    choices.push({
      name: `Rename the new one to ${clash.incomingRename}`,
      value: "rename-incoming",
    });
  if (
    clash.installed.renamable !== false &&
    validInstalledName(clash.installedRename)
  )
    choices.push({
      name: `Rename the installed one to ${clash.installedRename}`,
      value: "rename-installed",
    });
  choices.push(
    { name: "Don't install the new one", value: "skip-incoming" },
    {
      name: "Replace the installed one with the new one",
      value: "replace-installed",
    },
  );
  const choice = await select({
    loop: false,
    message: "What should BarnDog do?",
    choices,
    theme: promptTheme,
  });
  console.log(
    dim(
      "  Saved. Change it later with barndog " +
        (clash.kind === "skill" ? "skills" : "mcp") +
        " rename, enable or disable.",
    ),
  );
  return choice;
}
