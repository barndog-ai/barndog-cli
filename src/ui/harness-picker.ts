import checkbox from "@inquirer/checkbox";
import type { Harness } from "../harnesses/registry.js";
import type { HarnessChoice } from "../features/onboarding/setup.js";
import { checkboxTheme, selected } from "./theme.js";
import { dim } from "./format.js";

/** What the picker asks, and whether it accepts an empty answer. */
type HarnessQuestion = { message: string; required: boolean };

const manage: HarnessQuestion = {
  message: "Which coding tools should BarnDog manage?",
  required: false,
};

/** Asks which coding tools to manage; tests pass their own answer. */
export type ChooseHarnesses = (
  choices: HarnessChoice[],
  question?: HarnessQuestion,
) => Promise<Harness[]>;

export const chooseHarnesses: ChooseHarnesses = (
  choices,
  question = manage,
) => {
  const width = Math.max(...choices.map((choice) => choice.name.length));

  return checkbox<Harness>({
    loop: false,
    message: question.message,
    required: question.required,
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
