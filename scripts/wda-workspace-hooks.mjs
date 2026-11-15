import fs from 'node:fs';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_WDA_LOADER_NODE_VERSION = { major: 22, minor: 18 };

export function isSupportedWdaLoaderNodeVersion(version = process.versions.node) {
  const [majorStr, minorStr] = String(version).split('.');
  const major = Number(majorStr);
  const minor = Number(minorStr);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  return (
    major > MIN_WDA_LOADER_NODE_VERSION.major ||
    (major === MIN_WDA_LOADER_NODE_VERSION.major && minor >= MIN_WDA_LOADER_NODE_VERSION.minor)
  );
}

export function assertSupportedWdaLoaderRuntime(options = {}) {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const registerHooksFn =
    'registerHooks' in options ? options.registerHooks : nodeModule.registerHooks;
  if (!isSupportedWdaLoaderNodeVersion(nodeVersion)) {
    throw new Error(
      `WDA workspace loaders require Node.js >=22.18 (for node:module.registerHooks and default TypeScript type stripping); found ${nodeVersion}.`,
    );
  }
  if (typeof registerHooksFn !== 'function') {
    throw new Error(
      'node:module.registerHooks is unavailable; WDA workspace loaders require Node.js >=22.18.',
    );
  }
  return registerHooksFn;
}

let registered = false;

export function registerWdaWorkspaceHooks() {
  if (registered) return;
  const registerHooks = assertSupportedWdaLoaderRuntime();
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
  registered = true;
}

registerWdaWorkspaceHooks();

