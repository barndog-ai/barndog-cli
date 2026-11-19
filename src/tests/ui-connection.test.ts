import { beforeEach, expect, test, vi } from "vitest";
import input from "@inquirer/input";
import select from "@inquirer/select";
import {
  chooseConnection,
  chooseLocalAssets,
  chooseMoveTarget,
  promptServer,
} from "../ui/connection.js";

vi.mock("@inquirer/input", () => ({ default: vi.fn() }));
vi.mock("@inquirer/select", () => ({ default: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

const HTTPS_ONLY_MESSAGE =
  "Enter an HTTPS server origin, such as https://barndog.example.com (HTTP is allowed for localhost).";

test("server prompt trims what was typed and returns the normalized origin", async () => {
  vi.mocked(input).mockResolvedValue("  https://example.com  ");

  expect(await promptServer("https://current.example")).toBe(
    "https://example.com",
  );
});

test("server prompt offers the current server as the default", async () => {
  vi.mocked(input).mockResolvedValue("https://example.com");
  await promptServer("https://current.example");

  expect(vi.mocked(input).mock.calls[0]![0].default).toBe(
    "https://current.example",
  );
});

test("server prompt shows the typed text without surrounding spaces", async () => {
  vi.mocked(input).mockResolvedValue("https://example.com");
  await promptServer();

  const options = vi.mocked(input).mock.calls[0]![0];
  expect(options.transformer!("  x  ", { isFinal: false })).toBe("x");
});

test.each([
  ["https://example.com", true],
  ["  https://example.com  ", true],
  ["http://localhost:3000", true],
  ["http://example.com", HTTPS_ONLY_MESSAGE],
  ["not a url", HTTPS_ONLY_MESSAGE],
])("server prompt validates %j as %j", async (value, expected) => {
  vi.mocked(input).mockResolvedValue("https://example.com");
  await promptServer();

  const options = vi.mocked(input).mock.calls[0]![0];
  expect(await options.validate!(value)).toBe(expected);
});

test("connection prompt defaults to the current kind and returns the local choice", async () => {
  vi.mocked(select).mockResolvedValue("local");

  expect(
    await chooseConnection({ kind: "cloud", server: "https://x.test" }),
  ).toEqual({ kind: "local" });

  expect(vi.mocked(select).mock.calls[0]![0].default).toBe("cloud");
  expect(input).not.toHaveBeenCalled();
});

test("connection prompt has no default when nothing is connected yet", async () => {
  vi.mocked(select).mockResolvedValue("local");
  await chooseConnection();

  expect(vi.mocked(select).mock.calls[0]![0].default).toBeUndefined();
});

test("choosing cloud asks for the server and defaults to the current one", async () => {
  vi.mocked(select).mockResolvedValue("cloud");
  vi.mocked(input).mockResolvedValue("https://cloud.example");

  expect(
    await chooseConnection({ kind: "cloud", server: "https://old.example" }),
  ).toEqual({ kind: "cloud", server: "https://cloud.example" });

  expect(vi.mocked(input).mock.calls[0]![0].default).toBe(
    "https://old.example",
  );
});

test("choosing cloud from a Git setup does not offer the Git URL as the server", async () => {
  vi.mocked(select).mockResolvedValue("cloud");
  vi.mocked(input).mockResolvedValue("https://other.example");

  expect(
    await chooseConnection({
      kind: "git",
      url: "https://github.com/acme/old.git",
    }),
  ).toEqual({ kind: "cloud", server: "https://other.example" });

  expect(vi.mocked(input).mock.calls[0]![0].default).not.toBe(
    "https://github.com/acme/old.git",
  );
});

test("choosing Git asks for the repository URL, defaults to the current one and trims the answer", async () => {
  vi.mocked(select).mockResolvedValue("git");
  vi.mocked(input).mockResolvedValue(" https://github.com/acme/assets.git ");

  expect(
    await chooseConnection({
      kind: "git",
      url: "https://github.com/acme/old.git",
    }),
  ).toEqual({ kind: "git", url: "https://github.com/acme/assets.git" });

  expect(vi.mocked(input).mock.calls[0]![0].default).toBe(
    "https://github.com/acme/old.git",
  );
});

test("choosing Git with nothing connected has no default URL", async () => {
  vi.mocked(select).mockResolvedValue("git");
  vi.mocked(input).mockResolvedValue("https://github.com/acme/other.git");

  expect(await chooseConnection()).toEqual({
    kind: "git",
    url: "https://github.com/acme/other.git",
  });

  expect(vi.mocked(input).mock.calls[0]![0].default).toBeUndefined();
});

test.each([
  ["https://github.com/acme/assets.git", true],
  ["ext::dangerous", "That isn't a Git repository URL: ext::dangerous"],
  ["", "That isn't a Git repository URL: (empty)"],
  ["--upload-pack=evil", "That isn't a Git repository URL: --upload-pack=evil"],
  [
    "https://user:secret@github.com/acme/assets.git",
    "Remove the password or token from the URL. BarnDog uses your own Git credentials and never stores them.",
  ],
])("Git URL prompt validates %j as %j", async (value, expected) => {
  vi.mocked(select).mockResolvedValue("git");
  vi.mocked(input).mockResolvedValue("https://github.com/acme/assets.git");
  await chooseConnection();

  const options = vi.mocked(input).mock.calls[0]![0];
  expect(await options.validate!(value)).toBe(expected);
});

test.each([
  [1, "You have 1 local asset. What should happen to it?"],
  [2, "You have 2 local assets. What should happen to them?"],
])(
  "local asset prompt for %i asset(s) offers keep, copy, move and leave and returns the choice",
  async (count, message) => {
    vi.mocked(select).mockResolvedValue("move");

    expect(await chooseLocalAssets(count)).toBe("move");

    const options = vi.mocked(select).mock.calls[0]![0];
    expect(options.message).toBe(message);
    expect(options.choices).toEqual([
      expect.objectContaining({ value: "keep" }),
      expect.objectContaining({ value: "copy" }),
      expect.objectContaining({ value: "move" }),
      expect.objectContaining({ value: "leave" }),
    ]);
  },
);

test("move target prompt offers exactly the given targets and returns the pick", async () => {
  const targets = [
    { value: "target", name: "Target" },
    { value: "other", name: "Other" },
  ];

  vi.mocked(select).mockResolvedValue("other");

  expect(await chooseMoveTarget(targets)).toBe("other");
  expect(vi.mocked(select).mock.calls[0]![0].choices).toEqual(targets);
});
