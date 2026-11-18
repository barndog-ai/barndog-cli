import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import select from "@inquirer/select";
import confirm from "@inquirer/confirm";
import { CliError } from "../errors.js";
import { promptClash } from "../ui/clash.js";
import { DecisionRequiredError } from "../ui/decision-error.js";
import { renderJsonError } from "../ui/output.js";
import { runSelection } from "../ui/selection.js";
import type { Clash, ClashChoice } from "../features/environment/names.js";
import type { SelectionOutcome } from "../features/environment/operations.js";

vi.mock("@inquirer/select", () => ({ default: vi.fn() }));
vi.mock("@inquirer/confirm", () => ({ default: vi.fn() }));

beforeEach(() => {
  vi.mocked(select).mockReset();
  vi.mocked(confirm).mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("name clash prompt", () => {
  const installed = {
    id: "old",
    kind: "skill" as const,
    name: "review",
    origin: { type: "org", slug: "acme" },
    installed: true,
  };

  const incoming = {
    ...installed,
    id: "new",
    origin: { type: "team", slug: "web" },
    installed: false,
  };

  const clash: Clash = {
    kind: "skill",
    name: "review",
    installed,
    incoming,
    installedRename: "old-review",
    incomingRename: "new-review",
  };

  /** Runs the prompt and returns the choices it offered, as [value, label]. */
  async function offered(overrides: Partial<Clash>) {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(select).mockResolvedValue("skip-incoming");
    await promptClash({ ...clash, ...overrides });

    return (
      vi.mocked(select).mock.lastCall![0].choices as {
        value: ClashChoice;
        name: string;
      }[]
    ).map((choice) => [choice.value, choice.name]);
  }

  const RENAME_INCOMING = [
    "rename-incoming",
    "Rename the new one to new-review",
  ];

  const RENAME_INSTALLED = [
    "rename-installed",
    "Rename the installed one to old-review",
  ];

  const SKIP = ["skip-incoming", "Don't install the new one"];
  const REPLACE = [
    "replace-installed",
    "Replace the installed one with the new one",
  ];

  test("offers both renames, skipping and replacing", async () => {
    expect(await offered({})).toEqual([
      RENAME_INCOMING,
      RENAME_INSTALLED,
      SKIP,
      REPLACE,
    ]);
  });

  test("does not offer to rename an asset that can't be renamed", async () => {
    expect(
      await offered({ installed: { ...installed, renamable: false } }),
    ).toEqual([RENAME_INCOMING, SKIP, REPLACE]);

    expect(
      await offered({ incoming: { ...incoming, renamable: false } }),
    ).toEqual([RENAME_INSTALLED, SKIP, REPLACE]);
  });

  test("offers only skipping and replacing when neither can be renamed", async () => {
    expect(
      await offered({
        installed: { ...installed, renamable: false },
        incoming: { ...incoming, renamable: false },
      }),
    ).toEqual([SKIP, REPLACE]);
  });

  test("an explicitly renamable asset is offered a rename", async () => {
    expect(
      await offered({ installed: { ...installed, renamable: true } }),
    ).toEqual([RENAME_INCOMING, RENAME_INSTALLED, SKIP, REPLACE]);
  });

  test("does not offer a rename to a name that is not valid", async () => {
    expect(await offered({ installedRename: "", incomingRename: "" })).toEqual([
      SKIP,
      REPLACE,
    ]);

    expect(await offered({ incomingRename: "Bad Name" })).toEqual([
      RENAME_INSTALLED,
      SKIP,
      REPLACE,
    ]);
  });

  test("shows both origins, returns the choice and says where to change it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(select).mockResolvedValue("rename-installed");

    expect(await promptClash(clash)).toBe("rename-installed");
    expect(vi.mocked(select).mock.lastCall![0].message).toBe(
      "What should BarnDog do?",
    );

    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "",
      "! Two Skills want the name review",
      "  Installed  org",
      "  New        team/web",
      "",
      "  Saved. Change it later with barndog skills rename, enable or disable.",
    ]);
  });
});

const applied: SelectionOutcome = { status: "applied", events: [] };

const decision: SelectionOutcome = {
  status: "decision-required",
  conflicts: [
    {
      asset: {
        id: "a",
        name: "Alpha",
        kind: "skill",
        origin: { type: "org", id: "org" },
        publishedVersion: "v1",
      },
      excluded: true,
      individuallyDisabled: false,
    },
    {
      asset: {
        id: "b",
        name: "Beta",
        kind: "mcp",
        origin: { type: "org", id: "org" },
        publishedVersion: "v1",
      },
      excluded: false,
      individuallyDisabled: true,
    },
  ],
};

/** Runs `body` as if stdin and stdout were a terminal (or not). */
async function withTerminal(isTTY: boolean, body: () => Promise<void>) {
  const streams = [process.stdin, process.stdout];
  const saved = streams.map((stream) =>
    Object.getOwnPropertyDescriptor(stream, "isTTY"),
  );

  for (const stream of streams) {
    Object.defineProperty(stream, "isTTY", {
      value: isTTY,
      configurable: true,
    });
  }

  try {
    await body();
  } finally {
    streams.forEach((stream, index) => {
      const descriptor = saved[index];
      if (descriptor) {
        Object.defineProperty(stream, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(stream, "isTTY");
      }
    });
  }
}

describe("override decisions in a terminal", () => {
  async function decide(type: string, confirmations: boolean[] = []) {
    vi.mocked(select).mockResolvedValue(type);
    for (const answer of confirmations) {
      vi.mocked(confirm).mockResolvedValueOnce(answer);
    }

    const change = vi
      .fn()
      .mockResolvedValueOnce(decision)
      .mockResolvedValueOnce(applied);

    await withTerminal(true, async () => {
      await runSelection({ write: vi.fn() }, change);
    });

    return change;
  }

  test("preserve-all retries the change once with that decision", async () => {
    const change = await decide("preserve-all");

    expect(change).toHaveBeenCalledTimes(2);
    expect(change.mock.calls[0]).toEqual([undefined]);
    expect(change.mock.calls[1]).toEqual([{ type: "preserve-all" }]);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("clear-all retries the change once with that decision", async () => {
    const change = await decide("clear-all");

    expect(change.mock.calls[0]).toEqual([undefined]);
    expect(change.mock.calls[1]).toEqual([{ type: "clear-all" }]);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("per-asset asks about each asset and retries with the answers", async () => {
    const change = await decide("per-asset", [true, false]);

    expect(change.mock.calls[0]).toEqual([undefined]);
    expect(change.mock.calls[1]).toEqual([
      {
        type: "per-asset",
        decisions: [
          { assetId: "a", choice: "clear" },
          { assetId: "b", choice: "preserve" },
        ],
      },
    ]);

    expect(
      vi.mocked(confirm).mock.calls.map(([config]) => config.message),
    ).toEqual(["Clear overrides for Alpha?", "Clear overrides for Beta?"]);
  });

  test("the menu offers the three ways to decide", async () => {
    await decide("preserve-all");

    expect(
      vi
        .mocked(select)
        .mock.lastCall![0].choices.map(
          (choice) => (choice as { value: string }).value,
        ),
    ).toEqual(["preserve-all", "clear-all", "per-asset"]);
  });
});

describe("override decisions without a terminal", () => {
  const unresolved = () => vi.fn().mockResolvedValue(decision);

  const NEEDS_DECISION =
    "Existing exclusions or disabled assets need a decision:\n" +
    "  Alpha (Skill)  a\n" +
    "  Beta (MCP server)  b\n" +
    'A --decisions file lists each one as {"assetId": "<id>", "choice": "preserve"} or "clear".';

  test("--json prints an applied change without prompting", async () => {
    const write = vi.fn();
    await runSelection(
      { write, mode: { json: true, interactive: false } },
      vi.fn().mockResolvedValue(applied),
    );

    expect(JSON.parse(write.mock.lastCall![0])).toEqual(applied);
    expect(select).not.toHaveBeenCalled();
  });

  test("--json names every asset awaiting a decision and the flags that answer it", async () => {
    const failure = await runSelection(
      { write: vi.fn(), mode: { json: true, interactive: false } },
      unresolved(),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DecisionRequiredError);
    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({
      message: NEEDS_DECISION,
      hint: "add --overrides preserve, --overrides clear or --decisions <file>",
      decisions: [
        { assetId: "a", kind: "skill", name: "Alpha" },
        { assetId: "b", kind: "mcp", name: "Beta" },
      ],
    });

    expect(select).not.toHaveBeenCalled();
  });

  test("--no-interactive in a terminal asks nothing and names the flags instead", async () => {
    const failure = await runSelection(
      { write: vi.fn(), mode: { json: false, interactive: false } },
      unresolved(),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DecisionRequiredError);
    expect(select).not.toHaveBeenCalled();
  });

  test("the JSON error lists the decisions to make", async () => {
    const failure = await runSelection(
      { write: vi.fn(), mode: { json: true, interactive: false } },
      unresolved(),
    ).catch((error: unknown) => error);

    expect(JSON.parse(renderJsonError(failure))).toEqual({
      error: {
        message: NEEDS_DECISION,
        fix: "add --overrides preserve, --overrides clear or --decisions <file>",
        decisions: [
          { assetId: "a", kind: "skill", name: "Alpha" },
          { assetId: "b", kind: "mcp", name: "Beta" },
        ],
      },
    });
  });

  test("a non-terminal run fails the same way instead of prompting", async () => {
    await withTerminal(false, async () => {
      const failure = await runSelection(
        { write: vi.fn() },
        unresolved(),
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(DecisionRequiredError);
      expect(failure).toMatchObject({ message: NEEDS_DECISION });
    });

    expect(select).not.toHaveBeenCalled();
  });
});
