import { stripVTControlCharacters } from "node:util";
import { beforeEach, describe, expect, test, vi } from "vitest";
import input from "@inquirer/input";
import { NothingToDoError } from "../errors.js";
import type { Promotion } from "../features/discovery/index.js";
import { createProgram } from "../program.js";
import { pickMany, pickOne, type PickChoice } from "../ui/pick.js";
import type { Inventory, InventoryItem } from "../features/inventory/index.js";
import type { Applied } from "../features/environment/operations.js";
import type { CatalogAsset } from "../features/asset-kinds/index.js";

vi.mock("@inquirer/input", () => ({ default: vi.fn() }));
vi.mock("../ui/pick.js", async (original) => ({
  ...(await original<typeof import("../ui/pick.js")>()),
  pickMany: vi.fn(),
  pickOne: vi.fn(),
}));

const actualPick =
  await vi.importActual<typeof import("../ui/pick.js")>("../ui/pick.js");

const applied: Applied = { status: "applied", events: [] };
const item: InventoryItem = {
  id: "one",
  kind: "skill",
  name: "review",
  installedName: "review",
  origin: "org",
  via: ["individual"],
  state: "installed",
  paths: [],
  harnesses: [],
};

const inventory: Inventory = {
  server: null,
  offline: null,
  moving: [],
  knowledge: false,
  harnesses: [],
  items: [
    item,
    { ...item, id: "disabled", state: "disabled" },
    { ...item, id: "config", via: ["config"] },
    { ...item, id: "unavailable", origin: "—" },
    { ...item, id: "hook", kind: "hook" },
  ],
};

const catalog: CatalogAsset[] = ["one", "new", "other"].map((id) => ({
  id,
  kind: "skill",
  name: id,
  origin: { type: id === "other" ? "team" : "org", id: "org", slug: "web" },
  version: { number: 1, description: "Description" },
}));

type Offered = { ids: string[]; hints: (string | undefined)[] };

/** What the picker was shown: the choice values' ids and their hints. */
function offered(call: number, picker: typeof pickMany | typeof pickOne) {
  const choices = vi.mocked(picker).mock.calls[call]![1] as PickChoice<
    InventoryItem | string
  >[];

  return {
    ids: choices.map((choice) =>
      typeof choice.value === "string" ? choice.value : choice.value.id,
    ),
    hints: choices.map((choice) =>
      stripVTControlCharacters((choice.columns ?? []).join(" · ")),
    ),
  } satisfies Offered;
}

/** Like the real picker for an empty list; otherwise picks everything. */
function pickEverything() {
  vi.mocked(pickMany).mockImplementation(async (message, choices, options) => {
    if (!choices.length) {
      return actualPick.pickMany(message, choices, options);
    }

    return choices.map((choice) => choice.value);
  });
}

beforeEach(() => {
  vi.mocked(pickMany).mockReset();
  vi.mocked(pickOne).mockReset();
  vi.mocked(input).mockReset();
});

describe("interactive remove, enable and disable", () => {
  const eligible: Record<
    "remove" | "enable" | "disable",
    { ids: string[]; hints: string[] }
  > = {
    remove: {
      ids: ["one", "disabled"],
      hints: ["org · installed", "org · disabled"],
    },
    enable: { ids: ["disabled"], hints: ["org · disabled"] },
    disable: { ids: ["one"], hints: ["org · installed"] },
  };

  test.each(["remove", "enable", "disable"] as const)(
    "%s offers only this kind's selectable assets and applies the ones picked",
    async (action) => {
      pickEverything();
      const changeAssets = vi.fn().mockResolvedValue(applied);
      await createProgram({
        interactive: true,
        write: vi.fn(),
        inventory: async () => inventory,
        changeAssets,
      }).parseAsync(["skills", action], { from: "user" });

      expect(pickMany).toHaveBeenCalledTimes(1);
      expect(vi.mocked(pickMany).mock.calls[0]![0]).toBe(
        `Choose Skills to ${action}`,
      );

      expect(offered(0, pickMany)).toEqual(eligible[action]);
      expect(changeAssets).toHaveBeenCalledTimes(1);
      expect(changeAssets).toHaveBeenCalledWith(action, {
        kind: "skill",
        ids: eligible[action].ids,
        resolution: undefined,
      });
    },
  );

  test("only the assets the user picked are changed", async () => {
    vi.mocked(pickMany).mockImplementation(async (_, choices) => [
      choices[1]!.value,
    ]);

    const changeAssets = vi.fn().mockResolvedValue(applied);
    await createProgram({
      interactive: true,
      write: vi.fn(),
      inventory: async () => inventory,
      changeAssets,
    }).parseAsync(["skills", "remove"], { from: "user" });

    expect(changeAssets).toHaveBeenCalledWith("remove", {
      kind: "skill",
      ids: ["disabled"],
      resolution: undefined,
    });
  });

  test("enable with nothing disabled ends early and explains why", async () => {
    pickEverything();
    const changeAssets = vi.fn();
    const failure = await createProgram({
      interactive: true,
      write: vi.fn(),
      inventory: async () => ({ ...inventory, items: [item] }),
      changeAssets,
    })
      .parseAsync(["skills", "enable"], { from: "user" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NothingToDoError);
    expect(failure).toMatchObject({ message: "No Skills are disabled." });
    expect(changeAssets).not.toHaveBeenCalled();
  });

  test("remove with nothing installed ends early and explains why", async () => {
    pickEverything();
    const changeAssets = vi.fn();
    const failure = await createProgram({
      interactive: true,
      write: vi.fn(),
      inventory: async () => ({ ...inventory, items: [] }),
      changeAssets,
    })
      .parseAsync(["skills", "remove"], { from: "user" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NothingToDoError);
    expect(failure).toMatchObject({
      message: "No Skills to remove on this machine.",
    });

    expect(changeAssets).not.toHaveBeenCalled();
  });
});

describe("interactive install", () => {
  const cases: [string | undefined, string[], string[]][] = [
    [
      undefined,
      ["new", "other"],
      ["org · Description", "team/web · Description"],
    ],
    ["org", ["new"], ["org · Description"]],
    ["team:web", ["other"], ["team/web · Description"]],
  ];

  test.each(cases)(
    "origin %s offers %j without what is already selected",
    async (origin, ids, hints) => {
      pickEverything();
      const changeAssets = vi.fn().mockResolvedValue(applied);
      await createProgram({
        interactive: true,
        write: vi.fn(),
        inventory: async () => inventory,
        searchCatalog: async () => catalog,
        changeAssets,
      }).parseAsync(
        ["skills", "install", ...(origin ? ["--origin", origin] : [])],
        { from: "user" },
      );

      expect(pickMany).toHaveBeenCalledTimes(1);
      expect(vi.mocked(pickMany).mock.calls[0]![0]).toBe(
        "Choose Skills to install",
      );

      expect(offered(0, pickMany)).toEqual({ ids, hints });
      expect(changeAssets).toHaveBeenCalledWith("install", {
        kind: "skill",
        ids,
        overrides: undefined,
        decisions: undefined,
        resolution: undefined,
      });
    },
  );

  test("an origin with no assets ends early and points to add", async () => {
    pickEverything();
    const changeAssets = vi.fn();
    const failure = await createProgram({
      interactive: true,
      write: vi.fn(),
      inventory: async () => inventory,
      searchCatalog: async () => catalog,
      changeAssets,
    })
      .parseAsync(["skills", "install", "--origin", "missing"], {
        from: "user",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NothingToDoError);
    expect(failure).toMatchObject({
      message:
        "No Skills available to install. Add one with barndog skills add <source>.",
    });

    expect(changeAssets).not.toHaveBeenCalled();
  });

  test("an origin whose assets are all selected says so", async () => {
    pickEverything();
    const changeAssets = vi.fn();
    const failure = await createProgram({
      interactive: true,
      write: vi.fn(),
      inventory: async () => inventory,
      searchCatalog: async () => [catalog[0]!],
      changeAssets,
    })
      .parseAsync(["skills", "install", "--origin", "org"], { from: "user" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NothingToDoError);
    expect(failure).toMatchObject({
      message: "Every available Skill is already on this machine.",
    });

    expect(changeAssets).not.toHaveBeenCalled();
  });

  test("an asset waiting for removal is offered again", async () => {
    pickEverything();
    await createProgram({
      interactive: true,
      write: vi.fn(),
      inventory: async () => ({
        ...inventory,
        items: [{ ...item, state: "removing" }],
      }),
      searchCatalog: async () => [catalog[0]!],
      changeAssets: vi.fn().mockResolvedValue(applied),
    }).parseAsync(["skills", "install"], { from: "user" });

    expect(offered(0, pickMany).ids).toEqual(["one"]);
  });
});

describe("interactive rename", () => {
  async function rename(args: string[], installedName: string) {
    vi.mocked(pickOne).mockResolvedValue(item);
    const renameAsset = vi.fn().mockResolvedValue(applied);
    const write = vi.fn();
    await createProgram({
      interactive: true,
      write,
      inventory: async () => ({
        ...inventory,
        items: [
          { ...item, installedName },
          { ...item, id: "disabled", state: "disabled" },
        ],
      }),
      renameAsset,
    }).parseAsync(["skills", "rename", ...args], { from: "user" });

    return { renameAsset, lines: write.mock.calls.map(([line]) => line) };
  }

  test("offers the installed assets and suggests a name prefixed with the origin", async () => {
    vi.mocked(input).mockResolvedValue(" new-name ");
    await rename([], "new-name");

    expect(offered(0, pickOne)).toEqual({
      ids: ["one", "disabled"],
      hints: ["org · installed", "org · disabled"],
    });

    expect(input).toHaveBeenCalledTimes(1);
    expect(input).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "New local name",
        default: "org-review",
      }),
    );
  });

  test("renames to the trimmed answer and reports the installed name", async () => {
    vi.mocked(input).mockResolvedValue(" new-name ");
    const { renameAsset, lines } = await rename([], "new-name");

    expect(renameAsset).toHaveBeenCalledWith({
      kind: "skill",
      name: "one",
      origin: undefined,
      as: "new-name",
      reset: undefined,
    });

    expect(lines).toEqual([
      "\nBarnDog sync\n",
      "✔ Sync complete",
      "Everything is up to date.",
      "",
      "✔ review from org is installed as new-name.",
    ]);
  });

  test("--reset goes back to the published name without asking for one", async () => {
    const { renameAsset, lines } = await rename(["--reset"], "review");

    expect(input).not.toHaveBeenCalled();
    expect(renameAsset).toHaveBeenCalledWith({
      kind: "skill",
      name: "one",
      origin: undefined,
      as: undefined,
      reset: true,
    });

    expect(lines.at(-1)).toBe("✔ review uses its published name.");
  });

  test("with nothing installed ends early and explains why", async () => {
    vi.mocked(pickOne).mockImplementation(actualPick.pickOne);
    const failure = await createProgram({
      interactive: true,
      write: vi.fn(),
      inventory: async () => ({ ...inventory, items: [] }),
      renameAsset: vi.fn(),
    })
      .parseAsync(["skills", "rename"], { from: "user" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NothingToDoError);
    expect(failure).toMatchObject({
      message: "No Skills to rename on this machine.",
    });
  });
});

describe("interactive fork and promote", () => {
  const proposalId = "11111111-1111-4111-8111-111111111111";
  const published: Promotion = { kind: "skill", id: proposalId };
  const proposed: Promotion = {
    kind: "skill",
    id: proposalId,
    changeId: proposalId,
  };

  function chooseOne() {
    vi.mocked(pickOne).mockResolvedValue(catalog[0]!);
  }

  async function share(
    action: "fork" | "promote",
    answers: string[],
    promotion: Promotion,
  ) {
    chooseOne();
    for (const answer of answers) {
      vi.mocked(input).mockResolvedValueOnce(answer);
    }

    const fork = vi.fn().mockResolvedValue(promotion);
    const promote = vi
      .fn()
      .mockResolvedValue({ outcome: "promoted", promotion });

    const write = vi.fn();
    await createProgram({
      interactive: true,
      write,
      searchCatalog: async () => catalog,
      fork,
      promote,
    }).parseAsync(["skills", action], { from: "user" });

    return { fork, promote, lines: write.mock.calls.map(([line]) => line) };
  }

  test("fork asks for a destination (default me) and a name, then copies the picked asset", async () => {
    const { fork, promote, lines } = await share(
      "fork",
      ["me", "copied"],
      published,
    );

    expect(pickOne).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(input)
        .mock.calls.map(([config]) => [config.message, config.default]),
    ).toEqual([
      ["Destination scope (me, team/<slug>, repo/<slug> or org)", "me"],
      ["New name", "one"],
    ]);

    expect(fork).toHaveBeenCalledTimes(1);
    expect(fork).toHaveBeenCalledWith({
      kind: "skill",
      name: "one",
      origin: "org",
      target: "me",
      newName: "copied",
      key: undefined,
    });

    expect(promote).not.toHaveBeenCalled();
    expect(lines).toEqual([
      "✔ Created copied in me.",
      "Next: barndog skills install copied --origin me",
    ]);
  });

  test("a fork into a scope that needs review is a proposal", async () => {
    const { lines } = await share("fork", ["me", "copied"], proposed);

    expect(lines).toEqual([
      "✔ Proposed copied for me. A reviewer must merge the Suggested Change.",
      `Next: barndog skills changes show ${proposalId}`,
    ]);
  });

  test("promote has no default destination and promotes the picked asset", async () => {
    const { fork, promote, lines } = await share(
      "promote",
      ["team/web", "copied"],
      proposed,
    );

    expect(
      vi
        .mocked(input)
        .mock.calls.map(([config]) => [config.message, config.default]),
    ).toEqual([
      ["Destination scope (me, team/<slug>, repo/<slug> or org)", undefined],
      ["New name", "one"],
    ]);

    expect(promote).toHaveBeenCalledTimes(1);
    expect(promote).toHaveBeenCalledWith({
      kind: "skill",
      name: "one",
      origin: "org",
      target: "team/web",
      newName: "copied",
      key: undefined,
      confirmUrlQuery: expect.any(Function),
    });

    expect(fork).not.toHaveBeenCalled();
    expect(lines).toEqual([
      "✔ Proposed copied for team/web. A reviewer must merge the Suggested Change.",
      `Next: barndog skills changes show ${proposalId}`,
    ]);
  });

  test("a promotion that publishes at once says it created the asset", async () => {
    const { lines } = await share("promote", ["org", "copied"], published);

    expect(lines).toEqual([
      "✔ Created copied in org.",
      "Next: barndog skills install copied --origin org",
    ]);
  });
});

describe("promotion of a local asset", () => {
  const move = {
    target: "org",
    keepLocal: true,
    removed: [],
    rows: [{ kind: "skill", name: "release-notes", status: "moved" }],
  };

  const promoteLocal = (extra: string[]) => {
    const write = vi.fn();
    const promote = vi.fn().mockResolvedValue({ outcome: "moved", move });
    const run = createProgram({ write, promote }).parseAsync(
      [
        "skills",
        "promote",
        "review",
        "--origin",
        "local",
        "--target",
        "org",
        "--name",
        "copied",
        ...extra,
      ],
      { from: "user" },
    );

    return { run, write, promote };
  };

  test("asks to move the asset and shows the move outcome as a table", async () => {
    const { run, write, promote } = promoteLocal([]);
    await run;

    expect(promote).toHaveBeenCalledWith({
      kind: "skill",
      name: "review",
      origin: "local",
      target: "org",
      newName: "copied",
      key: undefined,
      confirmUrlQuery: expect.any(Function),
    });

    expect(write.mock.calls.map(([line]) => line)).toEqual([
      "  Status  Kind   Name",
      "  moved   skill  release-notes",
      "",
      expect.stringMatching(/local copies stay as separate assets/),
    ]);
  });

  test("--json prints the move itself", async () => {
    const { run, write } = promoteLocal(["--json"]);
    await run;

    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.lastCall![0])).toEqual(move);
  });
});

describe("an explicit origin narrows the picker", () => {
  const scopedInventory: Inventory = {
    ...inventory,
    items: [
      item,
      { ...item, id: "org-disabled", state: "disabled" },
      { ...item, id: "team-enabled", origin: "team/web" },
      { ...item, id: "team-disabled", origin: "team/web", state: "disabled" },
    ],
  };

  const expected: Record<"remove" | "enable" | "disable" | "rename", Offered> =
    {
      remove: {
        ids: ["team-enabled", "team-disabled"],
        hints: ["team/web · installed", "team/web · disabled"],
      },
      enable: { ids: ["team-disabled"], hints: ["team/web · disabled"] },
      disable: { ids: ["team-enabled"], hints: ["team/web · installed"] },
      rename: {
        ids: ["team-enabled", "team-disabled"],
        hints: ["team/web · installed", "team/web · disabled"],
      },
    };

  test.each(["remove", "enable", "disable"] as const)(
    "%s offers only assets from that origin",
    async (action) => {
      pickEverything();
      const changeAssets = vi.fn().mockResolvedValue(applied);
      await createProgram({
        interactive: true,
        write: vi.fn(),
        inventory: async () => scopedInventory,
        changeAssets,
      }).parseAsync(["skills", action, "--origin", "team:web"], {
        from: "user",
      });

      expect(pickMany).toHaveBeenCalledTimes(1);
      expect(offered(0, pickMany)).toEqual(expected[action]);
      expect(changeAssets).toHaveBeenCalledWith(action, {
        kind: "skill",
        ids: expected[action].ids,
        resolution: undefined,
      });
    },
  );

  test("rename offers only assets from that origin and keeps the origin", async () => {
    vi.mocked(pickOne).mockImplementation(
      async (_, choices) => choices[0]!.value,
    );

    const renameAsset = vi.fn().mockResolvedValue(applied);
    const write = vi.fn();
    await createProgram({
      interactive: true,
      write,
      inventory: async () => scopedInventory,
      renameAsset,
    }).parseAsync(["skills", "rename", "--origin", "team:web", "--reset"], {
      from: "user",
    });

    expect(pickOne).toHaveBeenCalledTimes(1);
    expect(offered(0, pickOne)).toEqual(expected.rename);
    expect(renameAsset).toHaveBeenCalledWith({
      kind: "skill",
      name: "team-enabled",
      origin: "team:web",
      as: undefined,
      reset: true,
    });

    expect(write.mock.lastCall![0]).toBe("✔ review uses its published name.");
  });
});
