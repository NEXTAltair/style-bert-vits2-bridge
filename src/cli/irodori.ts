import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function runIrodoriCli(
  argv: string[],
  io: { stdout: Pick<typeof process.stdout, "write">; stderr: Pick<typeof process.stderr, "write"> },
): Promise<number> {
  const script = fileURLToPath(new URL("../../scripts/irodori-workflow.py", import.meta.url));
  const python = process.env.IRODORI_BRIDGE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  return new Promise((resolve) => {
    const child = spawn(python, [script, ...argv], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    child.stdout.on("data", (chunk: Buffer) => io.stdout.write(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => io.stderr.write(chunk.toString("utf8")));
    child.once("error", (error) => {
      io.stderr.write(`Irodori workflow could not start: ${error.message}\n`);
      resolve(1);
    });
    child.once("close", (code) => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      resolve(code ?? 1);
    });
  });
}
