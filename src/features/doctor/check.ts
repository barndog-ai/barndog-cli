/** Names listed under one label in a grouped check: a server's variables, a tool's Hooks. */
export type CheckRow = { label: string; items: string[] };

export type Check = {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** Present when one check stands for several things with the same problem. */
  rows?: CheckRow[];
  fix?: string;
  /** A command that deletes or changes something; `fix` says it in words. */
  command?: string;
};
