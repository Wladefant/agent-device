import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { resolveUserConfigPath } from '@agent-device/host-kit/file';
import { readPluginManifest, type PluginManifest } from './manifest.ts';

export type LocalPackagePin = {
  path: string;
  sha256: string;
};
export type PluginSelection = {
  installation: string;
  version?: string;
  localPackage?: LocalPackagePin;
  options?: Record<string, unknown>;
};
type PluginConfig = Record<string, unknown> & { plugins?: Record<string, PluginSelection> };
export function readPluginConfig(env: NodeJS.ProcessEnv): PluginConfig {
  const configPath = resolveUserConfigPath(env);
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as PluginConfig;
    if (!isRecord(config) || (config.plugins !== undefined && !isRecord(config.plugins)))
      throw new AppError('INVALID_ARGS', 'Plugin config must contain an object');
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof SyntaxError)
      throw new AppError('INVALID_ARGS', `Invalid plugin JSON: ${configPath}`, {}, error);
    throw error;
  }
}

export function validatePluginSelection(name: string, selection: PluginSelection): void {
  if (
    !isPackageName(name) ||
    !isRecord(selection) ||
    typeof selection.installation !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(selection.installation) ||
    (selection.version !== undefined && !isVersionSelector(selection.version)) ||
    (selection.localPackage !== undefined &&
      (selection.version !== undefined || !isValidLocalPackageSelection(selection.localPackage))) ||
    (selection.options !== undefined && !isRecord(selection.options))
  ) {
    throw new AppError('INVALID_ARGS', `Invalid plugin selection: ${name}`);
  }
}

export function storeHome(env: NodeJS.ProcessEnv): string {
  return path.dirname(resolveUserConfigPath(env));
}

export function installationDirectory(home: string, name: string, installation: string): string {
  return path.join(home, 'plugins', installation, 'node_modules', name);
}

/**
 * The v1 manifests in the store, read without executing anything, including those of a package
 * that also exports `./agent-device`; unreadable selections are skipped.
 */
export function legacyStoreManifests(env: NodeJS.ProcessEnv): PluginManifest[] {
  const home = storeHome(env);
  let selections: [string, PluginSelection][];
  try {
    selections = Object.entries(readPluginConfig(env).plugins ?? {});
  } catch {
    return [];
  }
  return selections.flatMap(([name, selection]) => {
    try {
      validatePluginSelection(name, selection);
      const manifest = readPluginManifest(
        installationDirectory(home, name, selection.installation),
      );
      return manifest.name === name ? [manifest] : [];
    } catch {
      return [];
    }
  });
}

function isPackageName(value: string): boolean {
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
}

export function isVersionSelector(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-zA-Z0-9*^~<>=| .+-]+$/.test(value) && value.trim().length > 0
  );
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

export function isLocalTarballPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.trim().length === 0 || value.trim() !== value || value.includes('\0')) return false;
  // Reject URL schemes (file:, https:, npm:, etc.) while allowing Windows drive prefixes (C:\...).
  if (value.includes('://') || /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(value)) return false;
  if (!path.isAbsolute(value)) return false;
  return value.endsWith('.tgz') || value.endsWith('.tar.gz');
}

export function isValidLocalPackageSelection(value: unknown): value is LocalPackagePin {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('path') || !keys.includes('sha256')) return false;
  return isLocalTarballPath(value.path) && isSha256Hex(value.sha256);
}
