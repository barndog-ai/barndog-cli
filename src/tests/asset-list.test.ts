import { expect, test } from "vitest";
import { assetPage } from "../ui/asset-list.js";
import { renderCatalog } from "../ui/assets.js";
import { table } from "../ui/format.js";
import { createProgram } from "../program.js";
import { CommanderError } from "commander";

const rows = Array.from({ length: 65 }, (_, n) => ({
  id: String(n),
  kind: "skill" as const,
  name: `skill-${String(n).padStart(2, "0")}`,
  origin: { type: n % 2 ? "team" : "org", slug: "engineering", id: "x" },
  version: {
    number: 2,
    description: n % 2 ? "React code review" : "General conventions",
  },
}));

test("asset browsing bounds output, sorts before paging, and combines origin and keyword filters", () => {
  const options = { page: 2, limit: 20 };
  const result = assetPage([...rows].reverse(), options);
  expect(result.total).toBe(65);
  expect(result.rows).toStrictEqual(rows.slice(20, 40));
  const filtered = assetPage(rows, {
    ...options,
    page: 1,
    origin: "team/engineering",
    search: "react review",
  });

  expect(filtered.total).toBe(32);
  expect(filtered.rows.every((r) => r.origin.type === "team")).toBeTruthy();
  const rendered = renderCatalog(
    rows,
    options,
    "barndog skills search",
    new Set(),
  ).join("\n");

  expect(rendered).toMatch(/Showing 21–40 of 65/);
  expect(rendered).toMatch(/barndog skills search --page 3/);
  expect(rendered).not.toMatch(/skill-40/);
});

test("a truncated cell keeps its styling", () => {
  const [line] = table([["\u001b[2mlong description\u001b[22m"]], {
    indent: 0,
    width: 8,
  });

  expect(line).toBe("\u001b[2mlong de…\u001b[22m");
  const [boundary] = table(
    [["\u001b[1mabcdefg\u001b[22m\u001b[2mhijkl\u001b[22m"]],
    {
      indent: 0,
      width: 8,
    },
  );

  expect(boundary).toBe("\u001b[1mabcdefg\u001b[22m\u001b[2m…\u001b[22m");
});

test("the version column only appears when something has a version number", () => {
  const options = { page: 1, limit: 20 };
  const render = (list: typeof rows) =>
    renderCatalog(list, options, "barndog skills search", new Set()).join("\n");

  const hashed = {
    ...rows[0]!,
    version: { ...rows[0]!.version, label: "1e708e1" },
  };

  const local = render([hashed]);
  expect(local).not.toMatch(/Ver|1e708e1/);
  expect(local).toMatch(/General conventions/);
  const mixed = render([hashed, rows[1]!]);
  expect(mixed).toMatch(/Ver/);
  expect(mixed).toMatch(/v2/);
  expect(mixed).not.toMatch(/1e708e1/);
});

test("list output escapes terminal control sequences and reports empty pages clearly", () => {
  const text = renderCatalog(
    [{ ...rows[0]!, name: "evil\u001b[31m" }],
    { page: 1, limit: 20 },
    "barndog skills search",
    new Set(),
  ).join("\n");

  expect(text).toContain("evil\\u001b[31m");
  expect(
    renderCatalog(
      rows,
      { page: 9, limit: 20 },
      "barndog skills search",
      new Set(),
    )[0]!,
  ).toMatch(/Page 9 is empty/);
});

test("list shows installed, then disabled, then available, and filters each", async () => {
  const onMachine = (
    id: string,
    state: "installed" | "disabled" | "pending",
  ) => ({
    id,
    kind: "skill" as const,
    name: id,
    installedName: id,
    origin: "org",
    via: ["org"],
    state,
    harnesses: [],
    paths: [],
  });

  const catalogRow = (id: string) => ({
    ...rows[0]!,
    id,
    name: id,
  });

  const items = [
    onMachine("off", "disabled"),
    onMachine("on", "installed"),
    onMachine("soon", "pending"),
  ];

  const run = async (
    args: string[],
    catalog: () => Promise<ReturnType<typeof catalogRow>[]> = async () => [
      catalogRow("zeta"),
      catalogRow("on"),
      catalogRow("alpha"),
    ],
  ) => {
    let loaded = 0;
    const lines: string[] = [];
    await createProgram({
      write: (line) => lines.push(line),
      writeError: () => {},
      searchCatalog: async () => {
        loaded++;

        return catalog();
      },
      inventory: async () => ({
        harnesses: [],
        server: null,
        knowledge: false,
        offline: null,
        items,
      }),
    }).parseAsync(["skills", "list", ...args], { from: "user" });

    return { text: lines.join("\n"), loaded };
  };

  const names = async (...args: string[]) =>
    (
      JSON.parse((await run([...args, "--json"])).text) as { name: string }[]
    ).map((item) => item.name);

  expect(await names()).toStrictEqual(["on", "soon", "off", "alpha", "zeta"]);
  expect(await names("--installed")).toStrictEqual(["on", "soon"]);
  expect(await names("--disabled")).toStrictEqual(["off"]);
  expect(await names("--available")).toStrictEqual(["alpha", "zeta"]);
  expect(await names("--disabled", "--available")).toStrictEqual([
    "off",
    "alpha",
    "zeta",
  ]);

  expect((await run(["--disabled"])).loaded).toBe(0);

  const table = (await run([])).text;
  expect(table).toMatch(/alpha .*available/);
  const paged = (await run(["--limit", "2"])).text;
  expect(paged).toMatch(/Showing 1–2 of 5/);
  expect(paged).toMatch(/barndog skills list --page 2/);
  expect(paged).not.toMatch(/alpha/);
  expect((await run(["--page", "9"])).text).toMatch(/Page 9 is empty/);

  const nothing = createProgram({
    write: (line) => emptyLines.push(line),
    writeError: () => {},
    searchCatalog: async () => [],
    inventory: async () => ({
      harnesses: [],
      server: null,
      knowledge: false,
      offline: null,
      items: [],
    }),
  });

  const emptyLines: string[] = [];
  await nothing.parseAsync(["mcp", "list"], { from: "user" });
  expect(emptyLines.join("\n")).toMatch(/No MCP servers yet\./);
  expect(emptyLines.join("\n")).toMatch(/barndog mcp add/);

  const failing = async () => {
    throw new Error("server down");
  };

  const partial = await run([], failing);
  expect(partial.text).toMatch(/Couldn't load available Skills: server down/);
  expect(partial.text).toMatch(/on .*installed/);
  await expect(run(["--available"], failing)).rejects.toThrow(/server down/);
});

test("search flags parse for every asset type and invalid pages fail before loading", async () => {
  let loaded = 0;
  const program = createProgram({
    write: () => {},
    writeError: () => {},
    searchCatalog: async () => {
      loaded++;

      return [];
    },
    inventory: async () => ({
      harnesses: [],
      server: null,
      knowledge: false,
      offline: null,
      items: [],
    }),
  });

  for (const kind of ["skills", "mcp", "hooks"]) {
    await program.parseAsync(
      [
        kind,
        "search",
        "review",
        "--origin",
        "org",
        "--page",
        "2",
        "--limit",
        "5",
      ],
      { from: "user" },
    );
  }

  expect(loaded).toBe(3);
  for (const args of [
    ["--limit", "101"],
    ["--page", "0"],
    ["--limit", "1.5"],
  ]) {
    await expect(
      program.parseAsync(["skills", "search", ...args], { from: "user" }),
    ).rejects.toThrow(CommanderError);
  }

  expect(loaded).toBe(3);
});

test("search returns the same matches as JSON and as a table", async () => {
  const catalog = ["review", "testing"].map((name) => ({
    id: name,
    kind: "skill" as const,
    name,
    origin: { type: "org", slug: "acme", id: "org" },
    version: { number: 1, description: `${name} helper` },
  }));

  const run = async (...args: string[]) => {
    const lines: string[] = [];
    await createProgram({
      write: (line) => lines.push(line),
      writeError: () => {},
      searchCatalog: async () => catalog,
      inventory: async () => ({
        harnesses: [],
        server: null,
        knowledge: false,
        offline: null,
        items: [],
      }),
    }).parseAsync(["skills", "search", "review", ...args], { from: "user" });

    return lines.join("\n");
  };

  const table = await run();
  expect(table).toMatch(/review/);
  expect(table).not.toMatch(/testing/);
  expect(
    (JSON.parse(await run("--json")) as { name: string }[]).map((r) => r.name),
  ).toStrictEqual(["review"]);
});
