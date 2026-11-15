import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar-stream';
import { test } from 'vitest';
import { pluginHome } from '@agent-device/test-kit';
import { changePlugin, listPlugins } from './store.ts';

async function packTarball(
  files: Record<string, string | Buffer>,
): Promise<{ buffer: Buffer; sha256: string }> {
  const pack = tar.pack();
  for (const [name, content] of Object.entries(files)) {
    pack.entry({ name }, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
  }
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  const buffer = gzipSync(Buffer.concat(chunks));
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { buffer, sha256 };
}

test('real-npm regression: local tarball with external file dependency is rejected before npm without creating links', async () => {
  const { home, env } = pluginHome();
  const sourceDir = path.join(home, 'sources');
  fs.mkdirSync(sourceDir, { recursive: true });

  const outsideDir = path.join(home, 'outside-target');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'index.js'), 'export const leaked = true;');

  const packageName = '@example/file-dep-plugin';
  const manifest = {
    name: packageName,
    version: '1.0.0',
    type: 'module',
    exports: { './agent-device': './plugin.mjs' },
    dependencies: {
      side: `file:${outsideDir.replaceAll('\\', '/')}`,
    },
  };

  const { buffer, sha256 } = await packTarball({
    'package/package.json': JSON.stringify(manifest),
    'package/plugin.mjs': 'export default function() { return { provider: "file-dep" }; }',
  });

  const tarballPath = path.join(sourceDir, 'file-dep.tgz');
  fs.writeFileSync(tarballPath, buffer);

  // Must reject before npm and not create any installation
  await assert.rejects(
    changePlugin('add', packageName, env, [], {
      localTarball: tarballPath,
      sha256,
      allowLocalPackage: true,
    }),
    { code: 'INVALID_ARGS' },
  );

  // Verify that no plugins directory was created or populated with escaping links
  const pluginsDir = path.join(home, 'plugins');
  if (fs.existsSync(pluginsDir)) {
    const entries = fs.readdirSync(pluginsDir);
    assert.equal(entries.length, 0, `Expected no staged installations, found: ${entries.join(', ')}`);
  }
  assert.deepEqual(await listPlugins(env, []), []);
});
