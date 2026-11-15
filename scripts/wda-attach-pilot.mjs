import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerWdaWorkspaceHooks } from './wda-workspace-hooks.mjs';

registerWdaWorkspaceHooks();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function parseFiniteNonNegativeCoord(name, raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    throw new Error(`--${name} must be a finite non-negative number.`);
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a finite non-negative number; received "${raw}".`);
  }
  return value;
}

const hasTapLabel = args['tap-label'] !== undefined;
const hasTapX = args['tap-x'] !== undefined;
const hasTapY = args['tap-y'] !== undefined;
if (hasTapLabel && (hasTapX || hasTapY)) {
  console.error('Cannot combine --tap-label with --tap-x/--tap-y.');
  process.exit(2);
}
if (hasTapX !== hasTapY) {
  console.error('Both --tap-x and --tap-y must be provided together.');
  process.exit(2);
}

let tap;
if (hasTapLabel) {
  if (!args['tap-label'].trim()) {
    console.error('--tap-label must not be empty.');
    process.exit(2);
  }
  tap = {
    kind: 'label',
    label: args['tap-label'],
    ...(args['tap-type'] ? { type: args['tap-type'] } : {}),
  };
} else if (hasTapX && hasTapY) {
  try {
    tap = {
      kind: 'point',
      x: parseFiniteNonNegativeCoord('tap-x', args['tap-x']),
      y: parseFiniteNonNegativeCoord('tap-y', args['tap-y']),
    };
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
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
