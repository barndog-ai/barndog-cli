import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isSpaceKey,
  isTabKey,
  isUpKey,
  makeTheme,
  useKeypress,
  useMemo,
  usePagination,
  usePrefix,
  useState,
} from "@inquirer/core";
import { cursorHide } from "@inquirer/ansi";
import { styleText } from "node:util";
import { NothingToDoError } from "../errors.js";
import { promptTheme, selected } from "./theme.js";
import { defined } from "../shared/lookup.js";

export type PickChoice<T> = {
  value: T;
  name: string;
  /** Dim text after the name, such as origin and description. */
  hint?: string;
  checked?: boolean;
};

type Config<T> = {
  message: string;
  choices: readonly PickChoice<T>[];
  multiple: boolean;
  pageSize?: number;
};

const matches = (choice: PickChoice<unknown>, search: string) => {
  const text = `${choice.name} ${choice.hint ?? ""}`.toLowerCase();

  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => text.includes(term));
};

const prompt = createPrompt(
  <T>(config: Config<T>, done: (value: T[]) => void) => {
    const theme = makeTheme({ prefix: promptTheme.prefix });
    const [status, setStatus] = useState<"idle" | "done">("idle");
    const prefix = usePrefix({ status, theme });
    const [search, setSearch] = useState("");
    const [checked, setChecked] = useState<ReadonlySet<number>>(
      new Set(
        config.choices.flatMap((choice, index) =>
          choice.checked ? [index] : [],
        ),
      ),
    );

    const [active, setActive] = useState(0);
    const [error, setError] = useState<string>();
    const nameWidth = useMemo(
      () =>
        Math.min(
          40,
          Math.max(0, ...config.choices.map((choice) => choice.name.length)),
        ),
      [],
    );

    const visible = useMemo(
      () =>
        config.choices
          .map((choice, index) => ({ choice, index }))
          .filter(({ choice }) => matches(choice, search)),
      [search],
    );

    useKeypress((key, rl) => {
      if (status !== "idle") {
        return;
      }

      const restore = () => {
        rl.clearLine(0);
        rl.write(search);
      };

      if (isEnterKey(key)) {
        const values = config.multiple
          ? [...checked]
              .sort((a, b) => a - b)
              .flatMap((i) => config.choices[i] ?? [])
          : visible[active]
            ? [visible[active].choice]
            : [];

        if (!values.length) {
          setError(
            config.multiple
              ? "Select at least one item with space."
              : "No matching item.",
          );

          restore();

          return;
        }

        setStatus("done");
        done(values.map((choice) => choice.value));
      } else if (isUpKey(key) || isDownKey(key)) {
        restore();
        if (!visible.length) {
          return;
        }

        const offset = isUpKey(key) ? -1 : 1;
        // The list stops at both ends instead of wrapping around.
        setActive(Math.min(visible.length - 1, Math.max(0, active + offset)));
      } else if (config.multiple && (isSpaceKey(key) || isTabKey(key))) {
        restore();
        const item = visible[active];
        if (!item) {
          return;
        }

        const next = new Set(checked);
        if (next.has(item.index)) {
          next.delete(item.index);
        } else {
          next.add(item.index);
        }

        setChecked(next);
        setError(undefined);
      } else {
        setSearch(rl.line);
        setActive(0);
        setError(undefined);
      }
    });

    const message = theme.style.message(config.message, status);
    if (status === "done") {
      const names = config.multiple
        ? [...checked].map((i) => config.choices[i]?.name).join(", ")
        : (visible[active]?.choice.name ?? "");

      return `${prefix} ${message} ${promptTheme.style.answer(names)}`;
    }

    const page = visible.length
      ? usePagination({
          items: visible,
          active,
          pageSize: config.pageSize ?? 10,
          loop: false,
          renderItem({ item, isActive }) {
            const cursor = isActive ? promptTheme.icon.cursor : " ";
            const box = config.multiple
              ? checked.has(item.index)
                ? selected("◉ ")
                : "◯ "
              : "";

            const padded = item.choice.name.padEnd(nameWidth);
            const name = isActive
              ? promptTheme.style.highlight(padded)
              : padded;

            // Leave a column spare so the terminal never wraps a row.
            const room =
              (process.stdout.columns || 100) -
              1 -
              4 -
              box.length -
              nameWidth -
              2;

            const text = item.choice.hint ?? "";
            const hint =
              text && room > 3
                ? `  ${styleText("dim", text.length > room ? `${text.slice(0, room - 1)}…` : text)}`
                : "";

            return `${cursor} ${box}${name}${hint}`;
          },
        })
      : styleText("dim", "  No matches");

    const filter = search
      ? styleText("bold", search)
      : styleText("dim", "type to filter");

    const keys = [
      ["↑↓", "move"] as const,
      ...(config.multiple ? [["space", "select"] as const] : []),
      ["⏎", config.multiple ? `confirm (${checked.size})` : "choose"] as const,
    ]
      .map(
        ([key, action]) =>
          `${styleText("bold", key)} ${styleText("dim", action)}`,
      )
      .join(styleText("dim", " • "));

    return [
      `${prefix} ${message} ${filter}`,
      [page, keys, ...(error ? [theme.style.error(error)] : [])].join("\n") +
        cursorHide,
    ];
  },
);

export function interactiveTerminal() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** A searchable list: type to filter, space to select, enter to confirm. */
export async function pickMany<T>(
  message: string,
  choices: readonly PickChoice<T>[],
  options: { empty?: string } = {},
): Promise<T[]> {
  if (!choices.length) {
    throw new NothingToDoError(options.empty ?? "Nothing to choose from.");
  }

  return prompt({ message, choices, multiple: true });
}

export async function pickOne<T>(
  message: string,
  choices: readonly PickChoice<T>[],
  options: { empty?: string } = {},
): Promise<T> {
  if (!choices.length) {
    throw new NothingToDoError(options.empty ?? "Nothing to choose from.");
  }

  const [value] = await prompt({ message, choices, multiple: false });

  return defined(value, "Nothing was chosen");
}
