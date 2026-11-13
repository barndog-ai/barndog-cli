/** The program and arguments that open `url` in the default browser on this platform. */
export function browserCommand(url: string): {
  command: string;
  args: string[];
} {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (process.platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }

  return { command: "xdg-open", args: [url] };
}
