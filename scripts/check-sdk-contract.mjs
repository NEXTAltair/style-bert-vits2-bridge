import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const configPath = path.resolve("tsconfig.json");
const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(configPath));
for (const file of config.fileNames) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && /^openclaw(?:\/|$)/u.test(node.name.text)) {
      throw new Error(`Local SDK declarations hide host contract changes: ${file}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const resolved = ts.resolveModuleName("openclaw/plugin-sdk/plugin-entry", path.resolve("src/index.ts"), config.options, ts.sys).resolvedModule;
if (!resolved?.isExternalLibraryImport || !resolved.resolvedFileName.endsWith(".d.ts")) {
  throw new Error("Install the real OpenClaw development SDK; a local facade or handwritten type stub is not sufficient.");
}
let root = path.dirname(resolved.resolvedFileName);
while (root !== path.dirname(root)) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    if (pkg.name === "openclaw") {
      console.log(`Real OpenClaw SDK ${pkg.version}: plugin-entry declarations resolved; no local SDK stubs.`);
      break;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  root = path.dirname(root);
}
