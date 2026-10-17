import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
const imports = (file: string) => [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)].map((match) => path.resolve(path.dirname(file), match[1]!));
const pluginDir = (target: string) => /plugins[\\/](ai|languages)[\\/]([^\\/]+)/.exec(path.relative(root, target));

describe("built-in plugin isolation", () => {
  it("reaches plugin directories only through plugins/builtin from shared code", () => {
    const leaks = files(root).filter((file) => !/\.test\.tsx?$/.test(file) && !path.relative(root, file).startsWith(`plugins${path.sep}`))
      .flatMap((file) => imports(file).filter((target) => pluginDir(target)).map((target) => `${path.relative(root, file)} -> ${path.relative(root, target)}`));
    expect(leaks).toEqual([]);
  });

  it("keeps each plugin from importing a sibling plugin's directory", () => {
    const leaks = files(path.join(root, "plugins")).flatMap((file) => {
      const own = pluginDir(file);
      return own ? imports(file).flatMap((target) => { const other = pluginDir(target); return other && (other[1] !== own[1] || other[2] !== own[2]) ? [`${path.relative(root, file)} -> ${path.relative(root, target)}`] : []; }) : [];
    });
    expect(leaks).toEqual([]);
  });
});
