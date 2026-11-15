import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { changePlugin, legacyStoreManifests, listPlugins } from './store.ts';
import {
  pluginHome,
  selectPlugin,
  selectV2Plugin,
  v2RegistrationSource,
  writePlugin,
} from '@agent-device/test-kit';

vi.mock('@agent-device/host-kit/command', () => ({ runCmd: vi.fn() }));
afterEach(() => vi.mocked(runCmd).mockReset());

const packageName = '@example/provider';
function readPluginConfig(env: NodeJS.ProcessEnv) {
  const file = path.join(env.AGENT_DEVICE_HOME!, 'config.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function installedPlugins(env: NodeJS.ProcessEnv) {
  const home = env.AGENT_DEVICE_HOME!;
  return Object.entries(readPluginConfig(env).plugins ?? {}).map(([name, selection]) => {
    const { installation, options } = selection as { installation: string; options?: unknown };
    return {
      name,
      selection: { installation, options },
      directory: path.join(home, 'plugins', installation, 'node_modules', name),
    };
  });
}

function installFixture(name = packageName, apiVersion = 1, provider = 'example') {
  vi.mocked(runCmd).mockImplementation(async (command, argv, options) => {
    const isWindowsNpmShim = process.platform === 'win32' && command === process.execPath;
    const npmArgs = isWindowsNpmShim ? argv.slice(1) : argv;
    if (isWindowsNpmShim) {
      assert.equal(path.basename(argv[0] ?? ''), 'npm-cli.js');
    } else {
      assert.equal(command, 'npm');
    }
    assert.equal(npmArgs[0], 'install');
    assert.equal(npmArgs[npmArgs.indexOf('--prefix') + 1], options!.cwd);
    assert.ok(npmArgs.includes('--global=false'));
    assert.ok(npmArgs.includes('--ignore-scripts'));
    assert.ok(npmArgs.includes('--no-audit'));
    assert.ok(npmArgs.includes('--no-fund'));
    assert.ok(npmArgs.includes('--workspaces=false'));
    assert.ok(npmArgs.includes('--package-lock=true'));
    writePlugin(options!.cwd!, name, apiVersion, provider);
    return { stdout: '', stderr: '', exitCode: 0 };
  });
}

test('add, pinned update and remove preserve flags, options and old installations', async () => {
  const { home, env } = pluginHome();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ platform: 'android' }));
  installFixture();
  await changePlugin('add', `${packageName}@1.2.3`, env, []);
  const [first] = installedPlugins(env);
  const config = readPluginConfig(env);
  config.plugins![packageName]!.options = { region: 'eu' };
  config.plugins![packageName]!.installation = '../damaged';
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  await changePlugin('update', packageName, env, []);
  const [second] = installedPlugins(env);
  assert.notEqual(first!.directory, second!.directory);
  assert.deepEqual(second!.selection.options, { region: 'eu' });
  const project = path.resolve(second!.directory, '../../..');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).dependencies,
    { [packageName]: '1.2.3' },
  );
  assert.equal(readPluginConfig(env).platform, 'android');
  await changePlugin('remove', packageName, env, []);
  assert.deepEqual(installedPlugins(env), []);
  assert.ok(fs.existsSync(first!.directory));
  assert.ok(fs.existsSync(second!.directory));
});

test('failed npm install and incompatible replacement preserve the active selection', async () => {
  const { home, env } = pluginHome();
  installFixture();
  await changePlugin('add', packageName, env, []);
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  vi.mocked(runCmd).mockRejectedValue(new Error('npm failed'));
  await assert.rejects(changePlugin('update', packageName, env, []), /npm failed/);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
  installFixture(packageName, 2);
  await assert.rejects(changePlugin('update', packageName, env, []), { code: 'INVALID_ARGS' });
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
  assert.equal(fs.readdirSync(path.join(home, 'plugins')).length, 1);
});

test('concurrent additions serialize without dropping the other package', async () => {
  const { env } = pluginHome();
  vi.mocked(runCmd).mockImplementation(async (_, __, options) => {
    const { dependencies } = JSON.parse(
      fs.readFileSync(path.join(options!.cwd!, 'package.json'), 'utf8'),
    );
    const name = Object.keys(dependencies)[0]!;
    writePlugin(options!.cwd!, name, 1, name);
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  await Promise.all([
    changePlugin('add', 'constructor', env, []),
    changePlugin('add', 'two', env, []),
  ]);
  assert.deepEqual(
    installedPlugins(env)
      .map(({ name }) => name)
      .sort(),
    ['constructor', 'two'],
  );
});

test('invalid package sources and damaged selections fail before invoking npm', async () => {
  const { home, env } = pluginHome();
  for (const name of [
    '--registry=evil',
    '../plugin',
    'plugin@file:../plugin',
    'plugin@npm:other',
    'https://example.com/plugin',
  ]) {
    await assert.rejects(changePlugin('add', name, env, []), { code: 'INVALID_ARGS' });
  }
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ plugins: { one: { installation: '../other' } } }),
  );
  assert.equal((await listPlugins(env, []))[0]?.compatible, false);
  await changePlugin('remove', 'one', env, []);
  assert.deepEqual(await listPlugins(env, []), []);
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ plugins: { UPPERCASE: null } }),
  );
  await changePlugin('remove', 'UPPERCASE', env, []);
  assert.deepEqual(await listPlugins(env, []), []);
  assert.equal(vi.mocked(runCmd).mock.calls.length, 0);
});

test('provider collisions refuse activation and preserve existing selections', async () => {
  const { env } = pluginHome();
  installFixture();
  await assert.rejects(changePlugin('add', packageName, env, ['example']), {
    code: 'INVALID_ARGS',
  });
  assert.deepEqual(installedPlugins(env), []);
  await changePlugin('add', packageName, env, []);
  installFixture('other');
  await assert.rejects(changePlugin('add', 'other', env, []), { code: 'INVALID_ARGS' });
  assert.equal(installedPlugins(env).length, 1);
});

test('broken siblings do not block pinned updates or unrelated additions', async () => {
  for (const damage of ['missing', 'json', 'abi']) {
    const { home, env } = pluginHome();
    installFixture();
    await changePlugin('add', `${packageName}@1.2.3`, env, []);
    selectPlugin(home, 'broken', 'broken', 'throw new Error("must not evaluate");', 2);
    const config = readPluginConfig(env);
    config.plugins![packageName]!.options = { region: 'eu' };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    const directory = path.join(home, 'plugins', config.plugins!.broken!.installation);
    if (damage === 'missing') fs.rmSync(directory, { recursive: true });
    if (damage === 'json')
      fs.writeFileSync(path.join(directory, 'node_modules/broken/package.json'), '{');
    await changePlugin('update', packageName, env, []);
    const repaired = readPluginConfig(env).plugins![packageName]!;
    assert.deepEqual(repaired.options, { region: 'eu' });
    assert.equal(repaired.version, '1.2.3');
    assert.deepEqual(readPluginConfig(env).plugins!.broken, config.plugins!.broken);
    installFixture('other', 1, 'other');
    await changePlugin('add', 'other', env, []);
    const listed = await listPlugins(env, []);
    assert.deepEqual(
      listed.map(({ name, compatible }) => [name, compatible]),
      [
        ['@example/provider', true],
        ['broken', false],
        ['other', true],
      ],
    );
  }
});

test('a package that declares the v1 manifest and exports ./agent-device still supplies its manifest', () => {
  const { home, env } = pluginHome();
  const directory = selectV2Plugin(home, 'dual', v2RegistrationSource('dual'), {
    manifest: {
      agentDevicePlugin: {
        apiVersion: 1,
        provider: 'dual',
        entry: './plugin.mjs',
        credentialVariables: ['DUAL_KEY'],
      },
    },
  });
  selectV2Plugin(home, 'v2-only', v2RegistrationSource('v2-only'));
  assert.deepEqual(
    legacyStoreManifests(env).map((manifest) => manifest.agentDevicePlugin.credentialVariables),
    [['DUAL_KEY']],
  );

  // An installation that holds another package supplies nothing under this selection's name.
  const manifestPath = path.join(directory, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, name: 'someone-else' }));
  assert.deepEqual(legacyStoreManifests(env), []);
});

function writeTarballFile(directory: string, filename: string, content: string): { path: string; sha256: string } {
  const filePath = path.join(directory, filename);
  const bytes = Buffer.from(content, 'utf8');
  fs.writeFileSync(filePath, bytes);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return { path: filePath, sha256 };
}

test('local tarball add stages pinned copy before npm, survives post-staging original mutation, and supports .tar.gz', async () => {
  const { home, env } = pluginHome();
  const sourceDir = path.join(home, 'sources');
  fs.mkdirSync(sourceDir, { recursive: true });
  const tgz = writeTarballFile(sourceDir, 'provider-v1.tgz', 'tarball-bytes-v1');
  const tarGz = writeTarballFile(sourceDir, 'other-v1.tar.gz', 'tar-gz-bytes-v1');

  vi.mocked(runCmd).mockImplementationOnce(async (_command, _argv, options) => {
    const project = options!.cwd!;
    const stagedFile = path.join(project, 'package.tgz');
    assert.equal(fs.readFileSync(stagedFile, 'utf8'), 'tarball-bytes-v1');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).dependencies,
      { [packageName]: 'file:./package.tgz' },
    );
    // Mutate the original source after staging to prove npm installs only the pinned staged copy.
    fs.writeFileSync(tgz.path, 'mutated-after-staging');
    writePlugin(project, packageName, 1, 'example');
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await changePlugin('add', packageName, env, [], {
    localTarball: tgz.path,
    sha256: tgz.sha256.toUpperCase(),
    allowLocalPackage: true,
  });

  const configAfterFirst = readPluginConfig(env);
  assert.equal(configAfterFirst.plugins[packageName].version, undefined);
  assert.deepEqual(configAfterFirst.plugins[packageName].localPackage, {
    path: tgz.path,
    sha256: tgz.sha256,
  });

  vi.mocked(runCmd).mockImplementationOnce(async (_command, _argv, options) => {
    const project = options!.cwd!;
    assert.equal(fs.readFileSync(path.join(project, 'package.tar.gz'), 'utf8'), 'tar-gz-bytes-v1');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).dependencies,
      { other: 'file:./package.tar.gz' },
    );
    writePlugin(project, 'other', 1, 'other');
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await changePlugin('add', 'other', env, [], {
    localTarball: tarGz.path,
    sha256: tarGz.sha256,
    allowLocalPackage: true,
  });

  const listed = await listPlugins(env, []);
  assert.deepEqual(
    listed.map(({ name, compatible, provider }) => [name, compatible, provider]),
    [
      ['@example/provider', true, 'example'],
      ['other', true, 'other'],
    ],
  );
});

test('local tarball add rejects invalid options, paths, symlinks, and sha256 before npm and preserves existing selection', async () => {
  const { home, env } = pluginHome();
  installFixture();
  await changePlugin('add', `${packageName}@1.2.3`, env, []);
  const beforeConfig = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  const beforeDirs = fs.readdirSync(path.join(home, 'plugins'));
  vi.mocked(runCmd).mockClear();

  const sourceDir = path.join(home, 'sources');
  fs.mkdirSync(sourceDir, { recursive: true });
  const valid = writeTarballFile(sourceDir, 'valid.tgz', 'valid-tarball');
  const symlinkPath = path.join(sourceDir, 'symlink.tgz');
  fs.symlinkSync(valid.path, symlinkPath);
  const dirAsTarball = path.join(sourceDir, 'dir.tgz');
  fs.mkdirSync(dirAsTarball);

  const invalidCases: Array<[string, Parameters<typeof changePlugin>[4]]> = [
    // Missing / partial options and opt-in
    [packageName, { localTarball: valid.path, sha256: valid.sha256 }],
    [packageName, { localTarball: valid.path, allowLocalPackage: true }],
    [packageName, { sha256: valid.sha256, allowLocalPackage: true }],
    [packageName, { allowLocalPackage: true }],
    [packageName, { localTarball: valid.path }],
    [packageName, { sha256: valid.sha256 }],
    // Combined with @version or @tag
    [`${packageName}@1.0.0`, { localTarball: valid.path, sha256: valid.sha256, allowLocalPackage: true }],
    [`${packageName}@latest`, { localTarball: valid.path, sha256: valid.sha256, allowLocalPackage: true }],
    // Relative paths and URLs
    [packageName, { localTarball: './valid.tgz', sha256: valid.sha256, allowLocalPackage: true }],
    [packageName, { localTarball: '../valid.tgz', sha256: valid.sha256, allowLocalPackage: true }],
    [packageName, { localTarball: 'valid.tgz', sha256: valid.sha256, allowLocalPackage: true }],
    [packageName, { localTarball: `file://${valid.path}`, sha256: valid.sha256, allowLocalPackage: true }],
    [packageName, { localTarball: 'https://example.com/valid.tgz', sha256: valid.sha256, allowLocalPackage: true }],
    // Bad extension, missing file, non-regular directory, symlink
    [packageName, { localTarball: path.join(sourceDir, 'bad.zip'), sha256: valid.sha256, allowLocalPackage: true }],
    [packageName, { localTarball: path.join(sourceDir, 'missing.tgz'), sha256: valid.sha256, allowLocalPackage: true }],
    [packageName, { localTarball: dirAsTarball, sha256: valid.sha256, allowLocalPackage: true }],
    [packageName, { localTarball: symlinkPath, sha256: valid.sha256, allowLocalPackage: true }],
    // Malformed and mismatched SHA-256
    [packageName, { localTarball: valid.path, sha256: 'abc', allowLocalPackage: true }],
    [packageName, { localTarball: valid.path, sha256: 'g'.repeat(64), allowLocalPackage: true }],
    [packageName, { localTarball: valid.path, sha256: `sha256:${valid.sha256}`, allowLocalPackage: true }],
    [packageName, { localTarball: valid.path, sha256: '0'.repeat(64), allowLocalPackage: true }],
  ];

  for (const [target, options] of invalidCases) {
    await assert.rejects(changePlugin('add', target, env, [], options), { code: 'INVALID_ARGS' });
  }

  assert.equal(vi.mocked(runCmd).mock.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), beforeConfig);
  assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), beforeDirs);
});

test('local tarball add cleans failed staging and preserves prior selection on package mismatch, staged tamper, npm failure, or provider collision', async () => {
  const { home, env } = pluginHome();
  installFixture();
  await changePlugin('add', `${packageName}@1.2.3`, env, []);
  const beforeConfig = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  const beforeDirs = fs.readdirSync(path.join(home, 'plugins'));

  const sourceDir = path.join(home, 'sources');
  fs.mkdirSync(sourceDir, { recursive: true });
  const tarball = writeTarballFile(sourceDir, 'plug.tgz', 'plug-bytes');

  // Package name mismatch in installed metadata
  vi.mocked(runCmd).mockImplementationOnce(async (_cmd, _argv, options) => {
    const dir = writePlugin(options!.cwd!, packageName, 1, 'other');
    const manifestPath = path.join(dir, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, name: '@wrong/package' }));
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  await assert.rejects(
    changePlugin('add', packageName, env, [], {
      localTarball: tarball.path,
      sha256: tarball.sha256,
      allowLocalPackage: true,
    }),
    { code: 'INVALID_ARGS' },
  );
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), beforeConfig);
  assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), beforeDirs);

  // Tampered staged archive before promotion
  vi.mocked(runCmd).mockImplementationOnce(async (_cmd, _argv, options) => {
    writePlugin(options!.cwd!, packageName, 1, 'example');
    fs.writeFileSync(path.join(options!.cwd!, 'package.tgz'), 'tampered-staged-bytes');
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  await assert.rejects(
    changePlugin('add', packageName, env, [], {
      localTarball: tarball.path,
      sha256: tarball.sha256,
      allowLocalPackage: true,
    }),
    { code: 'INVALID_ARGS' },
  );
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), beforeConfig);
  assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), beforeDirs);

  // npm install failure
  vi.mocked(runCmd).mockRejectedValueOnce(new Error('npm failed'));
  await assert.rejects(
    changePlugin('add', packageName, env, [], {
      localTarball: tarball.path,
      sha256: tarball.sha256,
      allowLocalPackage: true,
    }),
    /npm failed/,
  );
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), beforeConfig);
  assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), beforeDirs);

  // Provider collision with reserved built-in
  vi.mocked(runCmd).mockImplementationOnce(async (_cmd, _argv, options) => {
    writePlugin(options!.cwd!, 'other', 1, 'example');
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  await assert.rejects(
    changePlugin('add', 'other', env, [], {
      localTarball: tarball.path,
      sha256: tarball.sha256,
      allowLocalPackage: true,
    }),
    { code: 'INVALID_ARGS' },
  );
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), beforeConfig);
  assert.deepEqual(fs.readdirSync(path.join(home, 'plugins')), beforeDirs);
});

test('local tarball update requires --allow-local-package, reuses saved pin unless replacing both, and remove rejects local flags', async () => {
  const { home, env } = pluginHome();
  const sourceDir = path.join(home, 'sources');
  fs.mkdirSync(sourceDir, { recursive: true });
  const v1 = writeTarballFile(sourceDir, 'v1.tgz', 'v1-bytes');
  const v2 = writeTarballFile(sourceDir, 'v2.tgz', 'v2-bytes');

  installFixture();
  await changePlugin('add', packageName, env, [], {
    localTarball: v1.path,
    sha256: v1.sha256,
    allowLocalPackage: true,
  });

  const config = readPluginConfig(env);
  config.plugins[packageName].options = { region: 'eu' };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  const beforeConfig = fs.readFileSync(path.join(home, 'config.json'), 'utf8');

  vi.mocked(runCmd).mockClear();
  // Missing --allow-local-package on persisted local update fails before npm
  await assert.rejects(changePlugin('update', packageName, env, []), { code: 'INVALID_ARGS' });
  // Partial replacement fails before npm
  await assert.rejects(
    changePlugin('update', packageName, env, [], { localTarball: v2.path, allowLocalPackage: true }),
    { code: 'INVALID_ARGS' },
  );
  await assert.rejects(
    changePlugin('update', packageName, env, [], { sha256: v2.sha256, allowLocalPackage: true }),
    { code: 'INVALID_ARGS' },
  );
  assert.equal(vi.mocked(runCmd).mock.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), beforeConfig);

  // Reusing saved pin fails before npm if original file changed
  fs.writeFileSync(v1.path, 'corrupted-v1');
  await assert.rejects(
    changePlugin('update', packageName, env, [], { allowLocalPackage: true }),
    { code: 'INVALID_ARGS' },
  );
  assert.equal(vi.mocked(runCmd).mock.calls.length, 0);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), beforeConfig);

  // Restoring v1 bytes lets pinned update succeed with explicit opt-in
  fs.writeFileSync(v1.path, 'v1-bytes');
  await changePlugin('update', packageName, env, [], { allowLocalPackage: true });
  const updatedSame = readPluginConfig(env).plugins[packageName];
  assert.deepEqual(updatedSame.localPackage, { path: v1.path, sha256: v1.sha256 });
  assert.deepEqual(updatedSame.options, { region: 'eu' });

  // Replacing both path and sha256 updates persisted pin while keeping options
  await changePlugin('update', packageName, env, [], {
    localTarball: v2.path,
    sha256: v2.sha256,
    allowLocalPackage: true,
  });
  const updatedBoth = readPluginConfig(env).plugins[packageName];
  assert.deepEqual(updatedBoth.localPackage, { path: v2.path, sha256: v2.sha256 });
  assert.deepEqual(updatedBoth.options, { region: 'eu' });

  // remove rejects local flags without touching selection
  const beforeRemove = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  await assert.rejects(
    changePlugin('remove', packageName, env, [], { allowLocalPackage: true }),
    { code: 'INVALID_ARGS' },
  );
  await assert.rejects(
    changePlugin('remove', packageName, env, [], { localTarball: v2.path }),
    { code: 'INVALID_ARGS' },
  );
  await assert.rejects(
    changePlugin('remove', packageName, env, [], { sha256: v2.sha256 }),
    { code: 'INVALID_ARGS' },
  );
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), beforeRemove);

  // Plain remove removes the local selection while preserving old installation directories
  await changePlugin('remove', packageName, env, []);
  assert.deepEqual(installedPlugins(env), []);
});
