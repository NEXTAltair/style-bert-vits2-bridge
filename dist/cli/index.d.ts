#!/usr/bin/env node
interface CliIO {
    stdout?: Pick<typeof process.stdout, "write">;
    stderr?: Pick<typeof process.stderr, "write">;
}
export declare function runCli(argv: string[], io?: CliIO): Promise<number>;
export {};
