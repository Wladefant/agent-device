import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(repoRoot, 'packages');
const pkgExports = new Map();

for (const dir of fs.readdirSync(packagesDir)) {
  const pjPath = path.join(packagesDir, dir, 'package.json');
  if (!fs.existsSync(pjPath)) continue;
  const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  if (pj.name && pj.exports) {
    pkgExports.set(pj.name, { root: path.join(packagesDir, dir), exports: pj.exports });
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@agent-device/')) {
      const parts = specifier.split('/');
      const pkgName = parts.slice(0, 2).join('/');
      const sub = parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.';
      const entry = pkgExports.get(pkgName);
      if (entry) {
        const exp = entry.exports[sub];
        const target = typeof exp === 'string' ? exp : (exp?.default ?? exp?.types);
        if (target) {
          return {
            shortCircuit: true,
            url: pathToFileURL(path.resolve(entry.root, target)).href,
          };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
