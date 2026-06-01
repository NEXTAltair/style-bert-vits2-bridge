#!/usr/bin/env node
interface CliIO {
    stdout?: Pick<typeof process.stdout, "write">;
    stderr?: Pick<typeof process.stderr, "write">;
}
export declare function isCliEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean;
export declare function runCli(argv: string[], io?: CliIO): Promise<number>;
export {};
