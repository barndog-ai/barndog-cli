/** Ambient inputs captured once at a process entry point and passed through workflows. */
export type RuntimeContext = {
  home: string;
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  platform: NodeJS.Platform;
};
