import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { runCli } from '../../../cli.ts';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { pluginHome, selectPlugin, beginStdoutCapture } from '@agent-device/test-kit';
import { parseArgs, parseRawArgs, usageForCommand } from '../../parser/args.ts';
import { resolveCliOptions } from '../../resolve-cli-options.ts';
import { resolveConfigDefaults } from '@agent-device/command-surface';

vi.mock('../../../provider-device-runtimes.ts', () => {
  throw new Error('provider runtimes must remain unloaded');
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('plugins list and remove route through the CLI and emits JSON without daemon access or plugin evaluation', async () => {
  const { home } = pluginHome();
  vi.stubEnv('AGENT_DEVICE_HOME', home);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', path.join(home, 'state'));
  vi.stubEnv('AGENT_DEVICE_NO_UPDATE_NOTIFIER', '1');
  const marker = path.join(home, 'evaluated');
  selectPlugin(
    home,
    'example',
    'example',
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'yes');`,
  );
  const sendToDaemon = vi.fn(async () => {
    throw new Error('unexpected daemon access');
  });
  const stdoutCapture = beginStdoutCapture();
  let stdout = '';
  try {
    await runCli(['plugins', 'list', '--json'], {
      sendToDaemon,
    });
    stdout = stdoutCapture.read();
    const result = JSON.parse(stdout);
    assert.equal(result.success, true);
    assert.deepEqual(result.data.plugins, [
      { name: 'example', version: '1.2.3', provider: 'example', compatible: true },
    ]);
    assert.equal(sendToDaemon.mock.calls.length, 0);
    await runCli(['plugins', 'remove', 'example', '--json'], { sendToDaemon });
    assert.deepEqual(JSON.parse(stdoutCapture.read().slice(stdout.length)).data.plugins, []);
    assert.ok(!fs.existsSync(marker));
  } finally {
    stdoutCapture.restore();
  }
});

test('plugin schema exposes operator help and preserves scoped npm package specs', async () => {
  const args = parseRawArgs(['plugins', 'add', '@example/provider@^1.0.0', '--json']);
  assert.equal(args.command, 'plugins');
  assert.deepEqual(args.positionals, ['add', '@example/provider@^1.0.0']);
  const help = await usageForCommand('plugins');
  assert.ok(help);
  assert.match(help, /plugins list \[--state-dir <path>\]\|add/);
});

test('plugins list reports the running daemon inventory next to the store selections', async () => {
  const { home } = pluginHome();
  const stateDir = path.join(home, 'state');
  vi.stubEnv('AGENT_DEVICE_HOME', home);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  vi.stubEnv('AGENT_DEVICE_NO_UPDATE_NOTIFIER', '1');
  const owner = readCurrentOwnerIdentity();
  const failed = {
    provider: 'example',
    source: 'store',
    package: 'example',
    version: '1.2.3',
    state: 'failed',
    error: { code: 'INVALID_ARGS', message: 'bad plugin', reason: 'invalid_plugin' },
    credentials: { variables: [], byBackend: {} },
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'daemon.json'),
    JSON.stringify({
      token: 't',
      port: 1,
      pid: owner.pid,
      processStartTime: owner.startTime,
      plugins: [failed],
    }),
  );
  selectPlugin(home, 'example', 'example', 'export default () => {};');
  const stdoutCapture = beginStdoutCapture();
  try {
    await runCli(['plugins', 'list', '--json'], {
      sendToDaemon: vi.fn(async () => {
        throw new Error('unexpected daemon access');
      }),
    });
    const { data } = JSON.parse(stdoutCapture.read());
    assert.deepEqual(data.daemon, { pid: owner.pid, stateDir, plugins: [failed] });
    assert.equal(data.plugins[0].name, 'example');
  } finally {
    stdoutCapture.restore();
  }
});

test('--state-dir belongs to plugins list and daemon status, not to the commands that change the store', async () => {
  assert.equal(
    parseArgs(['plugins', 'list', '--state-dir', '/tmp/state']).flags.stateDir,
    '/tmp/state',
  );
  assert.throws(() => parseArgs(['plugins', 'add', 'example', '--state-dir', '/tmp/state']), {
    code: 'INVALID_ARGS',
  });
  assert.equal(
    parseArgs(['daemon', 'status', '--state-dir', '/tmp/state']).flags.stateDir,
    '/tmp/state',
  );
  assert.throws(() => parseArgs(['daemon', 'status', '--clean']), { code: 'INVALID_ARGS' });
  const help = await usageForCommand('daemon');
  assert.match(help ?? '', /daemon status \[--state-dir <path>\]/);
});

async function listPluginsAsText(home: string, stateDir: string): Promise<string> {
  vi.stubEnv('AGENT_DEVICE_HOME', home);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', stateDir);
  vi.stubEnv('AGENT_DEVICE_NO_UPDATE_NOTIFIER', '1');
  const stdoutCapture = beginStdoutCapture();
  try {
    await runCli(['plugins', 'list'], {
      sendToDaemon: vi.fn(async () => {
        throw new Error('unexpected daemon access');
      }),
    });
    return stdoutCapture.read();
  } finally {
    stdoutCapture.restore();
  }
}

test('plugins list names a plugin the running daemon did not register', async () => {
  const { home } = pluginHome();
  const stateDir = path.join(home, 'state');
  const owner = readCurrentOwnerIdentity();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'daemon.json'),
    JSON.stringify({
      token: 't',
      port: 1,
      pid: owner.pid,
      processStartTime: owner.startTime,
      plugins: [
        {
          provider: 'example',
          source: 'store',
          package: 'example',
          state: 'failed',
          error: { code: 'INVALID_ARGS', message: 'bad plugin', reason: 'invalid_plugin' },
          credentials: { variables: [], byBackend: {} },
        },
      ],
    }),
  );
  selectPlugin(home, 'example', 'example', 'export default () => {};');
  const text = await listPluginsAsText(home, stateDir);
  assert.match(text, /example@.* \(example\)/);
  assert.match(text, /The running daemon did not register example: bad plugin/);
});

test('plugins list says when the daemon record cannot be used instead of hiding it', async () => {
  const { home } = pluginHome();
  const stateDir = path.join(home, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'daemon.json'), '{not json');
  const text = await listPluginsAsText(home, stateDir);
  assert.match(text, /No provider plugins installed\./);
  assert.match(text, /daemon record for .* is invalid, so its providers are unknown/);
});

test('plugins CLI schema exposes local tarball flags on add/update and rejects them on list/remove', async () => {
  const sha = 'a'.repeat(64);
  const addParsed = parseArgs([
    'plugins',
    'add',
    '@example/provider',
    '--local-tarball',
    '/abs/provider.tgz',
    '--sha256',
    sha,
    '--allow-local-package',
  ]);
  assert.equal(addParsed.flags.localTarball, '/abs/provider.tgz');
  assert.equal(addParsed.flags.sha256, sha);
  assert.equal(addParsed.flags.allowLocalPackage, true);

  const updateParsed = parseArgs(['plugins', 'update', '@example/provider', '--allow-local-package']);
  assert.equal(updateParsed.flags.allowLocalPackage, true);

  for (const argv of [
    ['plugins', 'remove', '@example/provider', '--allow-local-package'],
    ['plugins', 'remove', '@example/provider', '--local-tarball', '/abs/provider.tgz'],
    ['plugins', 'remove', '@example/provider', '--sha256', sha],
    ['plugins', 'list', '--allow-local-package'],
    ['plugins', 'list', '--local-tarball', '/abs/provider.tgz'],
    ['plugins', 'list', '--sha256', sha],
  ]) {
    assert.throws(() => parseArgs(argv), { code: 'INVALID_ARGS' });
  }

  const help = await usageForCommand('plugins');
  assert.ok(help);
  assert.match(help, /--local-tarball <path>/);
  assert.match(help, /--sha256 <sha256>/);
  assert.match(help, /--allow-local-package/);
});

test('local plugin flags cannot come from config files or ambient environment variables', () => {
  const { home } = pluginHome();
  const sha = 'b'.repeat(64);
  for (const [key, value] of [
    ['allowLocalPackage', true],
    ['localTarball', '/abs/provider.tgz'],
    ['sha256', sha],
  ] as const) {
    fs.writeFileSync(path.join(home, 'agent-device.json'), JSON.stringify({ [key]: value }));
    assert.throws(
      () =>
        resolveConfigDefaults({
          command: 'plugins',
          cwd: home,
          cliFlags: { json: false, help: false, version: false },
          env: { AGENT_DEVICE_HOME: home },
        }),
      { code: 'INVALID_ARGS' },
    );
    fs.rmSync(path.join(home, 'agent-device.json'));

    const userConfig = path.join(home, 'config.json');
    fs.writeFileSync(userConfig, JSON.stringify({ [key]: value }));
    assert.throws(
      () =>
        resolveConfigDefaults({
          command: 'plugins',
          cwd: home,
          cliFlags: { json: false, help: false, version: false },
          env: { AGENT_DEVICE_HOME: home },
        }),
      { code: 'INVALID_ARGS' },
    );
    fs.rmSync(userConfig);
  }

  const resolved = resolveCliOptions(['plugins', 'add', '@example/provider'], {
    cwd: home,
    env: {
      AGENT_DEVICE_HOME: home,
      AGENT_DEVICE_ALLOW_LOCAL_PACKAGE: '1',
      AGENT_DEVICE_LOCAL_TARBALL: '/abs/provider.tgz',
      AGENT_DEVICE_SHA256: sha,
    },
  });
  assert.equal(resolved.flags.allowLocalPackage, undefined);
  assert.equal(resolved.flags.localTarball, undefined);
  assert.equal(resolved.flags.sha256, undefined);
});

test('plugins add rejects missing opt-in via runCli before touching daemon or store', async () => {
  const { home } = pluginHome();
  vi.stubEnv('AGENT_DEVICE_HOME', home);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', path.join(home, 'state'));
  vi.stubEnv('AGENT_DEVICE_NO_UPDATE_NOTIFIER', '1');
  const tarball = path.join(home, 'provider.tgz');
  fs.writeFileSync(tarball, 'fake-tgz');
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as never);
  const stdoutCapture = beginStdoutCapture();
  try {
    await assert.rejects(
      runCli(
        [
          'plugins',
          'add',
          '@example/provider',
          '--local-tarball',
          tarball,
          '--sha256',
          'c'.repeat(64),
          '--json',
        ],
        {
          sendToDaemon: vi.fn(async () => {
            throw new Error('unexpected daemon access');
          }),
        },
      ),
      /process\.exit:1/,
    );
    const result = JSON.parse(stdoutCapture.read());
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_ARGS');
    assert.ok(!fs.existsSync(path.join(home, 'config.json')));
  } finally {
    stdoutCapture.restore();
    exitSpy.mockRestore();
  }
});
