export declare function runIrodoriCli(argv: string[], io: {
    stdout: Pick<typeof process.stdout, "write">;
    stderr: Pick<typeof process.stderr, "write">;
}): Promise<number>;
