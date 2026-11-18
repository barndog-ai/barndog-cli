import { expect, test } from "vitest";
import {
  patchNative,
  type NativeEntry,
} from "../features/native/configuration.js";
import { parse } from "smol-toml";

const mcp: NativeEntry = {
  id: "one",
  kind: "mcp",
  harness: "claude",
  file: "config.json",
  key: "one",
  value: { command: "node" },
};

const hook: NativeEntry = {
  id: "hook",
  kind: "hook",
  harness: "claude",
  file: "settings.json",
  key: "SessionStart",
  value: { hooks: [{ type: "command", command: "echo test" }] },
};

test("native edits refuse malformed files, changed ownership and duplicate plans", () => {
  expect(() => patchNative(null, [], [])).toThrow("at least one entry");
  expect(() => patchNative("[", [], [mcp])).toThrow(
    "config.json isn't valid JSON, so BarnDog left it unchanged",
  );

  for (const text of ["[]", "null", "42", '{"mcpServers":[]}']) {
    expect(() => patchNative(text, [], [mcp])).toThrow(
      "config.json doesn't hold the settings object BarnDog expects",
    );
  }

  expect(() => patchNative("{}", [mcp], [])).toThrow("changed by hand");
  expect(() => patchNative(null, [], [mcp, { ...mcp, id: "two" }])).toThrow(
    "Two MCP servers",
  );

  expect(() => patchNative(null, [], [hook, hook])).toThrow("planned twice");
  for (const handlers of [null, {}, [], [hook.value, hook.value]]) {
    expect(() =>
      patchNative(
        JSON.stringify({ hooks: { SessionStart: handlers } }),
        [hook],
        [],
      ),
    ).toThrow("changed by hand");
  }

  expect(() =>
    patchNative('{"hooks":{"SessionStart":{}}}', [], [hook]),
  ).toThrow("isn't a list");

  expect(() =>
    patchNative(
      JSON.stringify({ hooks: { SessionStart: [hook.value] } }),
      [],
      [hook],
    ),
  ).toThrow("didn't add");
});

for (const index of [0, 1, 2]) {
  test(`removing owned hook ${index} preserves adjacent handlers and comments`, () => {
    const handlers = [
      { hooks: [{ type: "command", command: "echo first" }] },
      hook.value,
      { hooks: [{ type: "command", command: "echo last" }] },
    ];

    const owned = { ...hook, value: handlers[index]! };
    const text = `// retained\n${JSON.stringify({ hooks: { SessionStart: handlers }, unrelated: true })}`;
    const output = patchNative(text, [owned], []);
    expect(output).toContain("// retained");
    expect(
      JSON.parse(output.slice(output.indexOf("{"))).hooks.SessionStart,
    ).toEqual(handlers.filter((_, at) => at !== index));
  });
}

for (const text of [
  '[mcp_servers.one]\ncommand = "node"\n',
  '[mcp_servers]\none = { command = "node" }\n',
  '[mcp_servers]\n"one" = { command = "node" }\n',
  'mcp_servers.one.command = "node"\n',
]) {
  test(`Codex edits retain unrelated TOML when replacing ${JSON.stringify(text)}`, () => {
    const entry: NativeEntry = {
      ...mcp,
      harness: "codex",
      file: "config.toml",
    };

    const input = `# keep\nmodel = "example"\n${text}`;
    const output = patchNative(
      input,
      [entry],
      [{ ...entry, value: { command: "other" } }],
    );

    expect(output).toContain("# keep");
    expect(parse(output)).toMatchObject({
      model: "example",
      mcp_servers: { one: { command: "other" } },
    });

    const removed = patchNative(
      output,
      [{ ...entry, value: { command: "other" } }],
      [],
    );

    expect(JSON.stringify(parse(removed))).not.toContain("other");
  });
}

test("a Cursor hooks.json written without a version gets the one Cursor needs", () => {
  const cursorHook: NativeEntry = {
    ...hook,
    harness: "cursor",
    file: "hooks.json",
  };

  const output = patchNative('{ "hooks": {} }', [], [cursorHook]);

  expect(JSON.parse(output)).toMatchObject({
    version: 1,
    hooks: { SessionStart: [cursorHook.value] },
  });

  expect(() => patchNative('{ "version": 2 }', [], [cursorHook])).toThrow(
    "a version BarnDog doesn't support",
  );
});
