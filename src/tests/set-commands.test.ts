import { expect, test, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { createProgram } from "../program.js";
import { pickOne } from "../ui/pick.js";
import type { SetsList, Applied } from "../features/environment/operations.js";
import { CliError } from "../errors.js";

vi.mock("../ui/pick.js", async (original) => ({
  ...(await original<typeof import("../ui/pick.js")>()),
  pickOne: vi.fn(),
}));

const available: SetsList["available"] = [
  { type: "org", id: "org", slug: "acme", name: "Acme", canPublish: true },
  { type: "team", id: "team", slug: "web", name: "Web", canPublish: true },
  { type: "repo", id: "repo", slug: "app", name: "App", canPublish: true },
  { type: "repo", id: "repo2", slug: "other", name: "Other", canPublish: true },
];

const applied: Applied = { status: "applied", events: [] };

/** The organization is subscribed and active; the team is subscribed but paused. */
const subscribed: SetsList = {
  available,
  subscriptions: [
    { scope: { type: "org", id: "org" }, mode: "all", enabled: true },
    { scope: { type: "team", id: "team" }, mode: "all", enabled: false },
  ],
  diagnostics: [],
};

/** What each bare command offers, and the message the picker shows when there's nothing. */
const offered: Record<
  "install" | "remove" | "enable" | "disable" | "switch",
  { choices: string[]; empty: string }
> = {
  install: {
    choices: ["repo/app", "repo/other"],
    empty: "You're already subscribed to every scope.",
  },
  remove: {
    choices: ["org", "team/web"],
    empty: "You have no subscriptions yet.",
  },
  enable: {
    choices: ["team/web"],
    empty: "None of your subscriptions are paused.",
  },
  disable: {
    choices: ["org"],
    empty: "None of your subscriptions are active.",
  },
  switch: {
    choices: ["repo/app", "repo/other"],
    empty: "There is no other team or repository to switch to.",
  },
};

for (const [action, { choices, empty }] of Object.entries(offered)) {
  test(`bare sets ${action} offers ${choices.join(", ")} and acts on the pick`, async () => {
    const changeSet = vi.fn().mockResolvedValue(applied);
    const installSet = vi.fn().mockResolvedValue(applied);
    const switchSet = vi.fn().mockResolvedValue(applied);
    vi.mocked(pickOne).mockImplementation(
      async (_, offered) => offered[0]!.value,
    );

    await createProgram({
      interactive: true,
      write: vi.fn(),
      listSets: async () => subscribed,
      changeSet,
      installSet,
      switchSet,
    }).parseAsync(
      ["sets", action, ...(action === "install" ? ["--mode", "all"] : [])],
      { from: "user" },
    );

    const [, shown, options] = vi.mocked(pickOne).mock.lastCall!;
    expect(shown.map((choice) => choice.value)).toEqual(choices);
    expect(options).toMatchObject({ empty });

    const picked = expect.objectContaining({ origin: choices[0] });
    const calls = {
      install: () => expect(installSet).toHaveBeenCalledWith(picked),
      switch: () => expect(switchSet).toHaveBeenCalledWith(picked),
      other: () => expect(changeSet).toHaveBeenCalledWith(action, picked),
    };

    (action === "install" || action === "switch"
      ? calls[action]
      : calls.other)();
  });
}

test("bare sets commands without a terminal ask for the scope instead of opening a picker", async () => {
  vi.mocked(pickOne).mockReset();
  const error: unknown = await createProgram({
    interactive: false,
    write: vi.fn(),
    listSets: async () => subscribed,
  })
    .parseAsync(["sets", "enable"], { from: "user" })
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(CliError);
  expect(error).toHaveProperty("hint", "barndog sets enable <scope>");
  expect(pickOne).not.toHaveBeenCalled();
});

/** The scope column of the Available table. */
function availableScopes(output: string) {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.startsWith("Available"));
  const rows: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim() || !line.startsWith("  ")) {
      break;
    }

    rows.push(line.trim().split(/\s+/)[0]!);
  }

  return rows;
}

const listed: SetsList = {
  available,
  subscriptions: [
    { scope: { type: "team", id: "missing" }, mode: "all", enabled: false },
    { scope: { type: "org", id: "org" }, mode: "recommended", enabled: true },
  ],
  diagnostics: [],
};

for (const [filter, scopes] of [
  [[], ["repo/app", "repo/other", "team/web"]],
  [
    ["--origin", "repo"],
    ["repo/app", "repo/other"],
  ],
  [["--origin", "team:web"], ["team/web"]],
  [["--search", "APP"], ["repo/app"]],
  [["--search", "missing"], []],
  [["--page", "2", "--limit", "1"], ["repo/other"]],
] as const) {
  test(`sets list ${filter.join(" ") || "(no filter)"} shows ${scopes.join(", ") || "nothing"} as available`, async () => {
    const write = vi.fn();
    await createProgram({ write, listSets: async () => listed }).parseAsync(
      ["sets", "list", ...filter],
      { from: "user" },
    );

    const output = write.mock.calls.flat().join("\n");
    expect(availableScopes(output)).toEqual(scopes);
  });
}

test("sets list shows subscriptions, including ones you can no longer see, with their state", async () => {
  const write = vi.fn();
  await createProgram({ write, listSets: async () => listed }).parseAsync(
    ["sets", "list"],
    { from: "user" },
  );

  const output = write.mock.calls.flat().join("\n");
  expect(output).toMatch(/team\/missing\s+unavailable\s+all\s+disabled/);
  expect(output).toMatch(/org\s+Acme\s+recommended\s+enabled/);
});

test("sets list with only the local folder says why there's nothing else, and how to get more", async () => {
  const write = vi.fn();
  // How a local folder's model describes its one scope.
  const local = {
    type: "org" as const,
    id: "w1",
    slug: "local",
    name: "My workspace",
    canPublish: true,
    localOnly: true,
  };

  await createProgram({
    write,
    listSets: async () => ({
      available: [local],
      subscriptions: [
        { scope: { type: "org", id: "w1" }, mode: "all", enabled: true },
      ],
      diagnostics: [],
    }),
  }).parseAsync(["sets", "list"], { from: "user" });

  const output = stripVTControlCharacters(write.mock.calls.flat().join("\n"));
  expect(output).toMatch(/local\s+My workspace\s+all\s+enabled/);
  expect(output).toMatch(
    /the only set a local workspace has[\s\S]*Tip: barndog init/,
  );

  expect(output).not.toMatch(/Available|barndog sets install/);
});

test("sets list offers sets install only when there is something to subscribe to", async () => {
  const output = async (search: string) => {
    const write = vi.fn();
    await createProgram({ write, listSets: async () => listed }).parseAsync(
      ["sets", "list", "--search", search],
      { from: "user" },
    );

    return write.mock.calls.flat().join("\n");
  };

  expect(await output("app")).toContain("barndog sets install");
  expect(await output("missing")).not.toContain("barndog sets install");
});

test("sets list points at the next page only while there is one", async () => {
  const page = async (args: string[]) => {
    const write = vi.fn();
    await createProgram({ write, listSets: async () => listed }).parseAsync(
      ["sets", "list", ...args],
      { from: "user" },
    );

    return write.mock.calls.flat().join("\n");
  };

  expect(await page(["--limit", "1"])).toContain("barndog sets list --page 2");
  expect(await page(["--page", "3", "--limit", "1"])).not.toContain("--page 4");
});

test("switch-team normalizes bare team names while preserving explicit selectors", async () => {
  const switchSet = vi.fn().mockResolvedValue(applied);
  for (const selector of ["web", "team/web"]) {
    await createProgram({ write: vi.fn(), switchSet }).parseAsync(
      ["sets", "switch-team", selector],
      { from: "user" },
    );

    expect(switchSet).toHaveBeenLastCalledWith(
      expect.objectContaining({ origin: "team/web", mode: "recommended" }),
    );
  }
});
