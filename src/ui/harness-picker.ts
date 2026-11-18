import checkbox from "@inquirer/checkbox";
import type { Harness } from "../harnesses/registry.js";
import type { HarnessChoice } from "../features/onboarding/setup.js";
import { checkboxTheme, selected } from "./theme.js";
import { dim } from "./format.js";

/** Asks which coding tools to manage; tests pass their own answer. */
export type ChooseHarnesses = (choices: HarnessChoice[]) => Promise<Harness[]>;

export const chooseHarnesses: ChooseHarnesses = (choices) => {
  const width = Math.max(...choices.map((choice) => choice.name.length));

  return checkbox<Harness>({
    loop: false,
    message: "Which coding tools should BarnDog manage?",
    choices: choices.map((choice) => ({
      value: choice.value,
      checked: choice.checked,
      short: choice.name,
      name: `${choice.name.padEnd(width)}  ${choice.evidence ? selected("detected") : dim("not found")}`,
      description: choice.evidence ?? undefined,
    })),
    theme: checkboxTheme,
  });
};
