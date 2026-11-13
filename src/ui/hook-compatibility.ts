import { bad, dim, fields, hint, ok, table } from "./format.js";

export type HookCompatibility = {
  /** A release number in a Cloud Workspace; a content hash in a local or Git one. */
  version: number | string;
  compatibility: {
    harness: string;
    status: "supported" | "partial" | "unsupported";
    runtimeIssue: string | null;
  }[];
};

/** Whether each coding tool has a version of the Hook, and whether it can run here. */
export function renderHookCompatibility(
  name: string,
  result: HookCompatibility,
): string[] {
  const missing = result.compatibility
    .filter((row) => row.status === "unsupported")
    .map((row) => row.harness);

  return [
    // A content hash is long; its first 7 characters identify it, as Git shows them.
    ...fields([
      [
        "Version",
        typeof result.version === "number"
          ? String(result.version)
          : result.version.slice(0, 7),
      ],
    ]),
    ...table(
      result.compatibility.map((row) => [
        row.harness,
        row.status === "supported" ? row.status : dim(row.status),
        row.status === "unsupported"
          ? dim("—")
          : row.runtimeIssue
            ? `${bad("✖")} ${row.runtimeIssue}`
            : ok("✔"),
      ]),
      { header: ["Tool", "Support", "Ready on this machine"], indent: 0 },
    ),
    ...(missing.length
      ? [
          "",
          `${dim(`No ${missing.join(" or ")} version yet.`)} ${hint(`barndog hooks adapt ${name} --for ${missing.join(" ")}`, "Tip")}`,
        ]
      : []),
  ];
}
