import { type Command } from "commander";
import { type CommandContext } from "./context.js";
import { assetKindList, assetKinds } from "../features/asset-kinds/index.js";
import { registerList, registerSearch } from "./asset-list.js";
import {
  registerInstall,
  registerRename,
  registerToggles,
} from "./asset-install.js";
import { registerSharing } from "./asset-share.js";
import { registerSets } from "./sets.js";

/**
 * Registers environment selection and subscription commands using the supplied
 * services.
 */
export function registerEnvironment(program: Command, context: CommandContext) {
  for (const kind of assetKindList) {
    const command = program
      .command(assetKinds[kind].command)
      .description(`Install, browse and manage ${assetKinds[kind].many}`);

    registerList(command, kind, context);
    registerSearch(command, kind, context);
    registerInstall(command, kind, context);
    registerToggles(command, kind, context);
    registerRename(command, kind, context);
    registerSharing(command, kind, context);
  }

  registerSets(program, context);
}
