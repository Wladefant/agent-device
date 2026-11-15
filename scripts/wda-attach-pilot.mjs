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

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'dry-run') {
      args.dryRun = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const endpoint = args.endpoint ?? 'http://127.0.0.1:18100';
const sessionId = args.session;
const udid = args.udid ?? '00008110-001C45413486801E';
const expectedBundleId = args['expected-bundle'] ?? 'com.wladefant.heylolo.dev';
const screenshotPath = args.screenshot ?? path.join(repoRoot, 'wda-attach-pilot-screenshot.png');
const outPath = args.out;

if (!sessionId) {
  console.error('Usage: node scripts/wda-attach-pilot.mjs --session <id> [--endpoint <url>] [--udid <udid>] [--expected-bundle <id>] [--tap-label <label> | --tap-x <x> --tap-y <y>] [--screenshot <png>] [--out <json>] [--dry-run]');
  process.exit(2);
}

let tap;
if (args['tap-label']) {
  tap = {
    kind: 'label',
    label: args['tap-label'],
    ...(args['tap-type'] ? { type: args['tap-type'] } : {}),
  };
} else if (args['tap-x'] !== undefined && args['tap-y'] !== undefined) {
  tap = { kind: 'point', x: Number(args['tap-x']), y: Number(args['tap-y']) };
}

// Static import hoists above registerHooks(), so load workspace TS entry after hook registration.
const { runWdaAttachSequence } = await import('@agent-device/provider-webdriver/wda-attach');
const result = await runWdaAttachSequence({
  endpoint,
  sessionId,
  udid,
  expectedBundleId,
  screenshotPath,
  tap,
  dryRun: Boolean(args.dryRun),
});

const json = `${JSON.stringify(result, null, 2)}\n`;
if (outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, json, 'utf8');
}
process.stdout.write(json);
