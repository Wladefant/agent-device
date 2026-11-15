import {
  isLocalTarballPath,
  isSha256Hex,
  isValidLocalPackageSelection,
  legacyStoreManifests,
  readPluginConfig,
  validatePluginSelection,
  storeHome,
  installationDirectory,
  isVersionSelector,
  type LocalPackagePin,
  type PluginSelection,
} from './store-legacy.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRecord } from '@agent-device/kernel/record';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import {
  acquireProcessLock,
  openVerifiedFileForRead,
  publishFileSync,
  resolveUserConfigPath,
} from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import type { PluginPackageEntry } from './discovery.ts';
import { ROUTING_PROVIDER_IDENTITIES, type PluginManifest } from './manifest.ts';
import type { PluginCandidate } from './registry.ts';

export { legacyStoreManifests };

type StoreInstallation = {
  name: string;
  version: string;
  directory: string;
  selection: PluginSelection;
  entry: PluginPackageEntry;
};

async function describeInstallation(
  name: string,
  directory: string,
  selection: PluginSelection,
): Promise<StoreInstallation> {
  const { discoverPluginEntry, readPackageJson } = await import('./discovery.ts');
  const packageJson = readPackageJson(directory);
  if (packageJson.name !== name)
    throw new AppError('INVALID_ARGS', `Plugin package identity mismatch: ${name}`);
  const version = typeof packageJson.version === 'string' ? packageJson.version : undefined;
  if (version === undefined) {
    throw new AppError('INVALID_ARGS', `Plugin package has no version: ${name}`, {
      reason: 'invalid_plugin',
    });
  }
  return { name, version, directory, selection, entry: discoverPluginEntry(directory) };
}

async function readInstallation(home: string, name: string, selection: PluginSelection) {
  validatePluginSelection(name, selection);
  return describeInstallation(
    name,
    installationDirectory(home, name, selection.installation),
    selection,
  );
}

async function loadInstallation({ name, directory, selection, entry }: StoreInstallation) {
  if (entry.kind === 'v1') {
    const { adaptLegacyPlugin } = await import('./legacy.ts');
    return adaptLegacyPlugin(entry.manifest, directory, selection.options);
  }
  const module = await import(pathToFileURL(entry.file).href);
  if (typeof module.default !== 'function')
    throw new AppError('INVALID_ARGS', `Plugin must export a default factory: ${name}`, {
      reason: 'invalid_plugin',
    });
  return await module.default(selection.options);
}

/**
 * The store's contribution to the provider registry, in package-name order. Nothing here runs
 * plugin code: a selection or package that cannot be read becomes a candidate that fails when
 * loaded, so one damaged installation never hides the others.
 */
export async function storePluginCandidates(env: NodeJS.ProcessEnv): Promise<PluginCandidate[]> {
  const home = storeHome(env);
  let selections: [string, PluginSelection][];
  try {
    selections = Object.entries(readPluginConfig(env).plugins ?? {});
  } catch (error) {
    return [{ source: 'store', load: () => Promise.reject(error) }];
  }
  const ordered = selections.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return await Promise.all(
    ordered.map(async ([name, selection]): Promise<PluginCandidate> => {
      try {
        const installation = await readInstallation(home, name, selection);
        return {
          source: 'store',
          package: name,
          version: installation.version,
          ...(installation.entry.kind === 'v1'
            ? { provider: installation.entry.manifest.agentDevicePlugin.provider }
            : {}),
          ...(selection.options ? { hostOptions: selection.options } : {}),
          load: () => loadInstallation(installation),
        };
      } catch (error) {
        return {
          source: 'store',
          package: name,
          ...(await readSelectionVersion(home, name, selection)),
          load: () => Promise.reject(error),
        };
      }
    }),
  );
}

// Only a selection that passed validation names a directory this process may read.
async function readSelectionVersion(
  home: string,
  name: string,
  selection: PluginSelection,
): Promise<{ version?: string }> {
  try {
    validatePluginSelection(name, selection);
    const { readPackageJson } = await import('./discovery.ts');
    const version = readPackageJson(
      installationDirectory(home, name, selection.installation),
    ).version;
    return typeof version === 'string' ? { version } : {};
  } catch {
    return {};
  }
}

export async function listPlugins(env: NodeJS.ProcessEnv, builtinProviders: readonly string[]) {
  const { claimProviderIds, resolveProviderPlugins } = await import('./registry.ts');
  const resolved = await resolveProviderPlugins([
    ...claimProviderIds(builtinProviders),
    ...(await storePluginCandidates(env)),
  ]);
  return resolved.inventory().map((entry) => ({
    name: entry.package,
    ...(entry.version !== undefined ? { version: entry.version } : {}),
    ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
    compatible: entry.state === 'active',
    ...(entry.error ? { error: entry.error } : {}),
  }));
}

type PluginAction = 'add' | 'update' | 'remove';

export type ChangePluginOptions = {
  localTarball?: string;
  sha256?: string;
  allowLocalPackage?: boolean;
};

function parsePluginRequest(action: PluginAction, input: string) {
  if (action === 'remove') return { name: input, version: undefined };
  const match =
    /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@(.+))?$/.exec(input);
  if (!match || !match[1] || (match[2] !== undefined && !isVersionSelector(match[2]))) {
    throw new AppError(
      'INVALID_ARGS',
      'Expected an npm package name, optionally followed by @version or @tag',
    );
  }
  if (action === 'update' && match[2] !== undefined)
    throw new AppError('INVALID_ARGS', 'update accepts a package name without a version');
  return { name: match[1], version: match[2] };
}

function assertLocalTarballPath(value: string): string {
  if (!isLocalTarballPath(value)) {
    throw new AppError(
      'INVALID_ARGS',
      'Expected --local-tarball to be an absolute path to a .tgz or .tar.gz file',
    );
  }
  return value;
}

function normalizeSha256(value: string): string {
  if (!isSha256Hex(value)) {
    throw new AppError('INVALID_ARGS', 'Expected --sha256 to be a 64-character hex digest');
  }
  return value.toLowerCase();
}

function resolveWindowsNpmCliScript(env: NodeJS.ProcessEnv): string | undefined {
  const advertised = env.npm_execpath?.trim();
  if (advertised) {
    const scriptPath = path.resolve(advertised);
    if (path.basename(scriptPath) === 'npm-cli.js' && isRegularFile(scriptPath)) return scriptPath;
  }
  const bundled = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  return isRegularFile(bundled) ? bundled : undefined;
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveNpmInvocation(
  env: NodeJS.ProcessEnv,
  args: string[],
): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: 'npm', args };
  const npmCliScript = resolveWindowsNpmCliScript(env);
  if (!npmCliScript) {
    throw new AppError('TOOL_MISSING', 'npm not found in PATH', {
      nodeExecPath: process.execPath,
      hint: 'Install Node.js with npm, or add npm to PATH, and retry.',
    });
  }
  return { command: process.execPath, args: [npmCliScript, ...args] };
}

async function runNpmInstall(project: string, env: NodeJS.ProcessEnv): Promise<void> {
  const invocation = resolveNpmInvocation(env, [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--global=false',
    '--prefix',
    project,
    '--workspaces=false',
    '--package-lock=true',
  ]);
  await runCmd(invocation.command, invocation.args, { cwd: project, env, timeoutMs: 120_000 });
}

function openSourceTarballForRead(tarballPath: string): number {
  let fd: number | undefined;
  try {
    fd = openVerifiedFileForRead(tarballPath);
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      `Local plugin tarball must be a regular file (symlinks are not allowed): ${tarballPath}`,
      {},
      error instanceof Error ? error : undefined,
    );
  }
  if (fd === undefined) {
    throw new AppError('INVALID_ARGS', `Local plugin tarball not found: ${tarballPath}`);
  }
  return fd;
}

function copyVerifiedTarballToStage(sourcePath: string, stagedPath: string): void {
  const sourceFd = openSourceTarballForRead(sourcePath);
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) && fs.constants.O_NOFOLLOW > 0
    ? fs.constants.O_NOFOLLOW
    : 0;
  let stagedFd: number | undefined;
  try {
    stagedFd = fs.openSync(
      stagedPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        offset += fs.writeSync(stagedFd, buffer, offset, bytesRead - offset);
      }
    }
  } finally {
    fs.closeSync(sourceFd);
    if (stagedFd !== undefined) fs.closeSync(stagedFd);
  }
}

function hashVerifiedFileSha256(filePath: string): string {
  let fd: number | undefined;
  try {
    fd = openVerifiedFileForRead(filePath);
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      `Staged plugin tarball must be a regular file: ${filePath}`,
      {},
      error instanceof Error ? error : undefined,
    );
  }
  if (fd === undefined) {
    throw new AppError('INVALID_ARGS', `Staged plugin tarball not found: ${filePath}`);
  }
  try {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function assertSha256Matches(actualHex: string, expectedHex: string, name: string): void {
  const actual = Buffer.from(actualHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new AppError('INVALID_ARGS', `Local plugin tarball SHA-256 mismatch for ${name}`);
  }
}

type StagedPlugin = {
  installation: string;
  project: string;
  entry: PluginPackageEntry;
};

async function stagePlugin(
  home: string,
  name: string,
  source: { kind: 'registry'; version: string | undefined } | { kind: 'local'; pin: LocalPackagePin },
  env: NodeJS.ProcessEnv,
): Promise<StagedPlugin> {
  const installation = crypto.randomUUID();
  const project = path.join(home, 'plugins', installation);
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  try {
    let stagedTarballPath: string | undefined;
    if (source.kind === 'local') {
      const stagedFileName = source.pin.path.endsWith('.tar.gz')
        ? 'package.tar.gz'
        : 'package.tgz';
      stagedTarballPath = path.join(project, stagedFileName);
      copyVerifiedTarballToStage(source.pin.path, stagedTarballPath);
      assertSha256Matches(hashVerifiedFileSha256(stagedTarballPath), source.pin.sha256, name);
      fs.writeFileSync(
        path.join(project, 'package.json'),
        JSON.stringify({
          private: true,
          dependencies: { [name]: `file:./${stagedFileName}` },
        }),
        { mode: 0o600 },
      );
    } else {
      fs.writeFileSync(
        path.join(project, 'package.json'),
        JSON.stringify({
          private: true,
          dependencies: { [name]: source.version ?? 'latest' },
        }),
      );
    }
    await runNpmInstall(project, env);
    if (source.kind === 'local' && stagedTarballPath !== undefined) {
      assertSha256Matches(hashVerifiedFileSha256(stagedTarballPath), source.pin.sha256, name);
    }
    const installDir = installationDirectory(home, name, installation);
    let installStats: fs.Stats;
    try {
      installStats = fs.lstatSync(installDir);
    } catch {
      throw new AppError('INVALID_ARGS', `Plugin package was not installed: ${name}`);
    }
    if (installStats.isSymbolicLink() || !installStats.isDirectory()) {
      throw new AppError('INVALID_ARGS', `Installed plugin must be a regular directory: ${name}`);
    }
    const staged = await describeInstallation(name, installDir, { installation });
    return { installation, project, entry: staged.entry };
  } catch (error) {
    fs.rmSync(project, { recursive: true, force: true });
    throw error;
  }
}

function validateLocalOptionsPreLock(
  action: PluginAction,
  version: string | undefined,
  options: ChangePluginOptions,
): { explicitPin?: LocalPackagePin; allowLocalPackage: boolean } {
  const hasLocalTarball = options.localTarball !== undefined;
  const hasSha256 = options.sha256 !== undefined;
  const allowLocalPackage = options.allowLocalPackage === true;
  const hasAnyLocalOption = hasLocalTarball || hasSha256 || allowLocalPackage;

  if (action === 'remove') {
    if (hasAnyLocalOption) {
      throw new AppError('INVALID_ARGS', 'remove does not accept local package flags');
    }
    return { allowLocalPackage: false };
  }

  if (action === 'add') {
    if (!hasAnyLocalOption) return { allowLocalPackage: false };
    if (version !== undefined) {
      throw new AppError(
        'INVALID_ARGS',
        'Local plugin tarball cannot be combined with @version or @tag',
      );
    }
    if (!allowLocalPackage) {
      throw new AppError(
        'INVALID_ARGS',
        'Installing a local plugin tarball requires --allow-local-package',
      );
    }
    if (!hasLocalTarball || !hasSha256) {
      throw new AppError(
        'INVALID_ARGS',
        'Local plugin installation requires both --local-tarball and --sha256',
      );
    }
    return {
      allowLocalPackage: true,
      explicitPin: {
        path: assertLocalTarballPath(options.localTarball!),
        sha256: normalizeSha256(options.sha256!),
      },
    };
  }

  if (hasLocalTarball !== hasSha256) {
    throw new AppError(
      'INVALID_ARGS',
      'Replacing a local plugin source requires both --local-tarball and --sha256',
    );
  }
  if (hasLocalTarball) {
    if (!allowLocalPackage) {
      throw new AppError(
        'INVALID_ARGS',
        'Updating a local plugin tarball requires --allow-local-package',
      );
    }
    return {
      allowLocalPackage: true,
      explicitPin: {
        path: assertLocalTarballPath(options.localTarball!),
        sha256: normalizeSha256(options.sha256!),
      },
    };
  }
  return { allowLocalPackage };
}

function resolveInstallSource(
  action: PluginAction,
  name: string,
  version: string | undefined,
  previous: PluginSelection | undefined,
  validated: { explicitPin?: LocalPackagePin; allowLocalPackage: boolean },
):
  | { kind: 'registry'; version: string | undefined }
  | { kind: 'local'; pin: LocalPackagePin } {
  if (validated.explicitPin) {
    return { kind: 'local', pin: validated.explicitPin };
  }
  if (action === 'update' && previous?.localPackage !== undefined) {
    if (!validated.allowLocalPackage) {
      throw new AppError(
        'INVALID_ARGS',
        `Updating a local plugin requires --allow-local-package: ${name}`,
      );
    }
    if (!isValidLocalPackageSelection(previous.localPackage)) {
      throw new AppError('INVALID_ARGS', `Invalid saved local plugin selection: ${name}`);
    }
    return {
      kind: 'local',
      pin: {
        path: previous.localPackage.path,
        sha256: previous.localPackage.sha256.toLowerCase(),
      },
    };
  }
  if (action === 'update' && validated.allowLocalPackage) {
    throw new AppError(
      'INVALID_ARGS',
      'Updating with --allow-local-package for a registry plugin requires --local-tarball and --sha256',
    );
  }
  const requested =
    action === 'update' && isVersionSelector(previous?.version) ? previous.version : version;
  return { kind: 'registry', version: requested };
}

export async function changePlugin(
  action: PluginAction,
  input: string,
  env: NodeJS.ProcessEnv,
  reservedProviders: readonly string[],
  options: ChangePluginOptions = {},
): Promise<void> {
  const { name, version } = parsePluginRequest(action, input);
  const validatedLocal = validateLocalOptionsPreLock(action, version, options);
  const configPath = resolveUserConfigPath(env);
  const home = path.dirname(configPath);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const release = await acquireProcessLock({
    lockDirPath: path.join(home, 'plugins.lock'),
    owner: { ...readCurrentOwnerIdentity(), acquiredAtMs: Date.now() },
    description: 'plugin installation',
  });
  let staged: StagedPlugin | undefined;
  try {
    const config = readPluginConfig(env);
    const selections = { ...config.plugins };
    const previous = Object.hasOwn(selections, name) ? selections[name] : undefined;
    if (action !== 'add' && !Object.hasOwn(selections, name))
      throw new AppError('INVALID_ARGS', `Plugin is not installed: ${name}`);
    if (action === 'remove') delete selections[name];
    else {
      const source = resolveInstallSource(action, name, version, previous, validatedLocal);
      staged = await stagePlugin(home, name, source, env);
      assertUniqueLegacyProviders(
        [
          ...legacyStoreManifests(env).filter((manifest) => manifest.name !== name),
          ...(staged.entry.kind === 'v1' ? [staged.entry.manifest] : []),
        ],
        reservedProviders,
      );
      selections[name] = {
        installation: staged.installation,
        ...(source.kind === 'local'
          ? { localPackage: source.pin }
          : { version: source.version }),
        ...(isRecord(previous?.options) ? { options: previous.options } : {}),
      };
    }
    publishFileSync({
      destination: configPath,
      contents: `${JSON.stringify({ ...config, plugins: selections }, null, 2)}\n`,
      mode: 0o600,
    });
  } catch (error) {
    if (staged) fs.rmSync(staged.project, { recursive: true, force: true });
    throw error;
  } finally {
    await release();
  }
}

// A v1 manifest names its provider before any code runs, so a clash is refused at install time. A
// v2 package names its provider only once loaded; the registry records a clash then.
function assertUniqueLegacyProviders(
  manifests: readonly PluginManifest[],
  reserved: readonly string[],
): void {
  const providers = new Set<string>([...ROUTING_PROVIDER_IDENTITIES, ...reserved]);
  for (const { agentDevicePlugin } of manifests) {
    if (providers.has(agentDevicePlugin.provider))
      throw new AppError(
        'INVALID_ARGS',
        `Duplicate provider plugin: ${agentDevicePlugin.provider}`,
        {
          reason: 'duplicate_provider',
        },
      );
    providers.add(agentDevicePlugin.provider);
  }
}
