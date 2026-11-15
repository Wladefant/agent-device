import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { SnapshotResult } from '@agent-device/contracts/interactor-types';
import type {
  ProviderProfileField,
  ProviderProfileFieldDeclaration,
} from '@agent-device/contracts/provider-profile-fields';
import { PROVIDER_PROFILE_FIELD_FLAGS } from '@agent-device/contracts/remote';
import { presentIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { createCloudWebDriverRuntime, type CloudWebDriverRuntime } from './runtime.ts';
import {
  WebDriverClient,
  type GuardedWdaTap,
  type GuardedWdaTapRequest,
  type WebDriverRequestPolicy,
} from './webdriver-client.ts';
import { acquireWebDriverIosSnapshot } from './webdriver-ios-snapshot.ts';

export type { GuardedWdaTap, GuardedWdaTapRequest };
const WDA_ATTACH_PROVIDER = 'wda-attach';

const WDA_ATTACH_PROFILE_FIELDS: ProviderProfileFieldDeclaration = {
  provider: WDA_ATTACH_PROVIDER,
  label: 'Local WDA attach',
  fields: Object.fromEntries(
    (Object.keys(PROVIDER_PROFILE_FIELD_FLAGS) as ProviderProfileField[]).map((field) => [
      field,
      'refused',
    ]),
  ) as Record<ProviderProfileField, 'refused'>,
};

export type WdaAttachRuntimeOptions = Readonly<{
  endpoint: string | URL;
  sessionId: string;
  udid?: string;
  deviceName?: string;
  clientVersion?: string;
  requestPolicy?: WebDriverRequestPolicy;
  guardedWdaTap?: GuardedWdaTap;
}>;

export type WdaAttachTapSpec =
  | Readonly<{ kind: 'label'; label: string; type?: string }>
  | Readonly<{ kind: 'point'; x: number; y: number }>;

export type WdaAttachSequenceOptions = Readonly<{
  endpoint: string | URL;
  sessionId: string;
  udid: string;
  deviceName?: string;
  expectedBundleId?: string;
  screenshotPath: string;
  tap?: WdaAttachTapSpec;
  dryRun?: boolean;
  requestPolicy?: WebDriverRequestPolicy;
  guardedWdaTap?: GuardedWdaTap;
}>;

export type WdaAttachSequenceResult = Readonly<{
  endpoint: string;
  sessionId: string;
  udid: string;
  dryRun: boolean;
  expectedBundleId?: string;
  activeAppBefore: Readonly<{ bundleId?: string; name?: string; pid?: number }>;
  activeAppAfter?: Readonly<{ bundleId?: string; name?: string; pid?: number }>;
  activeAppAfterShutdown?: Readonly<{ bundleId?: string; name?: string; pid?: number }>;
  statusReady: boolean | undefined;
  snapshot: Readonly<{
    backend: SnapshotResult['backend'];
    producer: SnapshotResult['producer'];
    viewport?: SnapshotResult['viewport'];
    nodeCount: number;
    sampleNodes: readonly Readonly<{
      ref: string;
      type?: string;
      label?: string;
      identifier?: string;
      rect?: SnapshotNode['rect'];
    }>[];
  }>;
  tap?: Readonly<{
    executed: boolean;
    targetRef?: string;
    targetLabel?: string;
    x: number;
    y: number;
  }>;
  screenshot: Readonly<{
    path: string;
    bytes: number;
  }>;
  sessionPreserved: boolean;
  timingsMs: Readonly<{
    status: number;
    activeAppBefore: number;
    allocate: number;
    snapshot: number;
    screenshot: number;
    tap?: number;
    activeAppAfter?: number;
    release: number;
    shutdown: number;
    activeAppAfterShutdown: number;
  }>;
}>;

export function createWdaAttachRuntime(options: WdaAttachRuntimeOptions): CloudWebDriverRuntime {
  const deviceId = options.udid ?? options.sessionId;
  return createCloudWebDriverRuntime({
    clientVersion: options.clientVersion ?? '0.21.38-wda-attach-pilot',
    provider: WDA_ATTACH_PROVIDER,
    endpoint: options.endpoint,
    platform: 'ios',
    deviceName: options.deviceName ?? 'Attached iOS Device',
    profileFields: WDA_ATTACH_PROFILE_FIELDS,
    existingSessionId: options.sessionId,
    sessionOwnership: 'attached',
    routeProfile: 'wda',
    guardedWdaTap: options.guardedWdaTap,
    requestPolicy: options.requestPolicy ?? { timeoutMs: 30_000, retryAttempts: 0 },
    deviceId: () => deviceId,
  });
}

function readBundleInfo(value: Record<string, unknown>): {
  bundleId?: string;
  name?: string;
  pid?: number;
} {
  return {
    ...(typeof value.bundleId === 'string' ? { bundleId: value.bundleId } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.pid === 'number' ? { pid: value.pid } : {}),
  };
}

function assertValidPointTapCoordinates(x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new AppError(
      'INVALID_ARGS',
      'WDA tap coordinates must be finite non-negative numbers.',
      { reason: 'invalid_tap_coordinates', x, y },
    );
  }
}

function resolveVerifiedTapTarget(
  snapshotResult: SnapshotResult,
  tap: WdaAttachTapSpec,
): { targetRef?: string; targetLabel?: string; x: number; y: number } {
  const viewport = snapshotResult.viewport;
  if (
    !viewport ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    throw new AppError(
      'COMMAND_FAILED',
      'WDA snapshot did not provide a valid viewport for tap validation.',
      { reason: 'missing_viewport' },
    );
  }
  if (tap.kind === 'point') {
    assertValidPointTapCoordinates(tap.x, tap.y);
    if (tap.x >= viewport.width || tap.y >= viewport.height) {
      throw new AppError(
        'INVALID_ARGS',
        `Tap point (${tap.x}, ${tap.y}) is outside viewport ${viewport.width}x${viewport.height}.`,
        { reason: 'tap_out_of_bounds', x: tap.x, y: tap.y, viewport },
      );
    }
    return { x: tap.x, y: tap.y };
  }

  const nodes = snapshotResult.nodes ?? [];
  const candidates = nodes.filter(
    (node) => node.label === tap.label && (tap.type === undefined || node.type === tap.type),
  );
  if (candidates.length === 0) {
    throw new AppError(
      'COMMAND_FAILED',
      `Could not resolve interactive snapshot target "${tap.label}" with valid rect.`,
      { reason: 'tap_target_not_found', label: tap.label, type: tap.type, nodeCount: nodes.length },
    );
  }

  const actionable = candidates.flatMap((node) => {
    if (!isPositiveFiniteRect(node.rect)) return [];
    if (node.enabled !== true || node.visibleToUser !== true) return [];
    if (node.hittable === false || node.interactionBlocked === 'covered') return [];
    const x = Math.round(node.rect.x + node.rect.width / 2);
    const y = Math.round(node.rect.y + node.rect.height / 2);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) return [];
    return [{ node, x, y }];
  });

  if (actionable.length > 1) {
    throw new AppError(
      'AMBIGUOUS_MATCH',
      `Multiple visible enabled targets matched label "${tap.label}".`,
      {
        reason: 'ambiguous_tap_target',
        label: tap.label,
        type: tap.type,
        matchCount: actionable.length,
      },
    );
  }
  if (actionable.length === 0) {
    throw new AppError(
      'COMMAND_FAILED',
      `Target "${tap.label}" is not visible, enabled, and within viewport bounds.`,
      {
        reason: 'tap_target_not_actionable',
        label: tap.label,
        type: tap.type,
        candidateCount: candidates.length,
      },
    );
  }
  const match = actionable[0]!;
  return {
    targetRef: match.node.ref,
    targetLabel: match.node.label,
    x: match.x,
    y: match.y,
  };
}

export async function runWdaAttachSequence(
  options: WdaAttachSequenceOptions,
): Promise<WdaAttachSequenceResult> {
  if (options.tap) {
    if (!options.dryRun && !options.guardedWdaTap) {
      throw new AppError(
        'INVALID_ARGS',
        'WDA attach sequence tap requires guardedWdaTap unless dryRun is true.',
        { reason: 'wda_tap_guard_required' },
      );
    }
    if (options.tap.kind === 'point') {
      assertValidPointTapCoordinates(options.tap.x, options.tap.y);
    } else if (!options.tap.label.trim()) {
      throw new AppError('INVALID_ARGS', 'WDA tap label must not be empty.', {
        reason: 'invalid_tap_target',
      });
    }
  }

  const endpointStr = String(options.endpoint);
  const probeClient = new WebDriverClient({
    clientVersion: '0.21.38-wda-attach-pilot',
    endpoint: options.endpoint,
    requestPolicy: options.requestPolicy ?? { timeoutMs: 30_000, retryAttempts: 0 },
  });
  probeClient.attachSession(options.sessionId);

  const tStatus0 = performance.now();
  const statusRes = await probeClient.status();
  const statusMs = Number((performance.now() - tStatus0).toFixed(2));

  const tActiveBefore0 = performance.now();
  const activeAppBefore = readBundleInfo(await probeClient.wdaActiveAppInfo());
  const activeAppBeforeMs = Number((performance.now() - tActiveBefore0).toFixed(2));

  if (options.expectedBundleId && activeAppBefore.bundleId !== options.expectedBundleId) {
    throw new AppError(
      'COMMAND_FAILED',
      `Foreground app mismatch before pilot sequence: expected ${options.expectedBundleId}, got ${activeAppBefore.bundleId ?? 'unknown'}.`,
      { expectedBundleId: options.expectedBundleId, actualBundleId: activeAppBefore.bundleId },
    );
  }

  const callerGuard = options.guardedWdaTap;
  const dispatchGuardedWdaTap: GuardedWdaTap | undefined = callerGuard
    ? async (request) => {
        if (options.expectedBundleId) {
          const activeApp = readBundleInfo(
            await probeClient.wdaActiveAppInfo({ retryAttempts: 0, signal: request.signal }),
          );
          if (activeApp.bundleId !== options.expectedBundleId) {
            throw new AppError(
              'COMMAND_FAILED',
              `Foreground app mismatch before WDA tap: expected ${options.expectedBundleId}, got ${activeApp.bundleId ?? 'unknown'}.`,
              {
                reason: 'wda_foreground_app_mismatch',
                expectedBundleId: options.expectedBundleId,
                actualBundleId: activeApp.bundleId,
                dispatched: 'no',
              },
            );
          }
        }
        if (options.tap) {
          const freshSource = await probeClient.source({
            retryAttempts: 0,
            signal: request.signal,
          });
          const freshSnapshot = presentIosSnapshotAcquisition(
            acquireWebDriverIosSnapshot(freshSource, options.udid, 'unsupported'),
            { interactiveOnly: true },
          );
          const freshTarget = resolveVerifiedTapTarget(freshSnapshot, options.tap);
          if (
            Math.abs(freshTarget.x - request.x) > 1 ||
            Math.abs(freshTarget.y - request.y) > 1
          ) {
            throw new AppError(
              'COMMAND_FAILED',
              `Tap target shifted before WDA dispatch: expected (${request.x}, ${request.y}), got (${freshTarget.x}, ${freshTarget.y}).`,
              {
                reason: 'wda_tap_target_shifted',
                expected: { x: request.x, y: request.y },
                actual: { x: freshTarget.x, y: freshTarget.y },
                dispatched: 'no',
              },
            );
          }
        }
        await callerGuard(request);
      }
    : undefined;

  const runtime = createWdaAttachRuntime({
    endpoint: options.endpoint,
    sessionId: options.sessionId,
    udid: options.udid,
    deviceName: options.deviceName,
    requestPolicy: options.requestPolicy,
    guardedWdaTap: dispatchGuardedWdaTap,
  });

  const lease: DeviceLease = {
    leaseId: `wda-attach-${options.sessionId}`,
    tenantId: 'local-pilot',
    runId: 'wda-attach-pilot',
    clientId: 'wda-attach-pilot',
    leaseProvider: WDA_ATTACH_PROVIDER,
    backend: 'ios-instance',
    deviceKey: `${WDA_ATTACH_PROVIDER}:${options.udid}`,
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
    heartbeatAt: Date.now(),
  };

  const device: DeviceInfo = {
    platform: 'apple',
    target: 'mobile',
    appleOs: 'ios',
    id: options.udid,
    name: options.deviceName ?? 'Attached iOS Device',
    kind: 'device',
    booted: true,
  };

  let tapResult: WdaAttachSequenceResult['tap'];
  let tapMs: number | undefined;
  let activeAppAfter: WdaAttachSequenceResult['activeAppAfter'];
  let activeAppAfterMs: number | undefined;

  const tAlloc0 = performance.now();
  await runtime.leaseLifecycle.allocate!(lease);
  const allocateMs = Number((performance.now() - tAlloc0).toFixed(2));

  const interactor = runtime.getInteractor(device);
  if (!interactor) {
    await runtime.shutdown();
    throw new AppError('SESSION_NOT_FOUND', 'Attached WDA runtime did not expose an interactor.');
  }

  let snapshotResult: SnapshotResult;
  let snapshotNodes: Array<SnapshotNode & { ref: string }>;
  let snapshotMs: number;
  let screenshotMs: number;
  let screenshotBytes: number;
  let releaseMs: number;
  let shutdownMs: number;

  try {
    const tSnap0 = performance.now();
    const rawSnapshot = await interactor.snapshot({ interactiveOnly: true });
    snapshotResult =
      'stage' in rawSnapshot
        ? presentIosSnapshotAcquisition(rawSnapshot, { interactiveOnly: true })
        : rawSnapshot;
    const nodes = snapshotResult.nodes;
    if (!nodes || !nodes.every((node): node is SnapshotNode & { ref: string } =>
      typeof node.ref === 'string' && node.ref.length > 0
    )) {
      throw new AppError('COMMAND_FAILED', 'WDA snapshot did not contain referenced nodes.');
    }
    snapshotNodes = nodes;
    snapshotMs = Number((performance.now() - tSnap0).toFixed(2));

    const tShot0 = performance.now();
    await interactor.screenshot(options.screenshotPath);
    screenshotMs = Number((performance.now() - tShot0).toFixed(2));
    screenshotBytes = (await fs.stat(options.screenshotPath)).size;

    if (options.tap) {
      const target = resolveVerifiedTapTarget(snapshotResult, options.tap);
      if (options.dryRun) {
        tapResult = { executed: false, ...target };
      } else {
        const tTap0 = performance.now();
        await interactor.tap(target.x, target.y);
        tapMs = Number((performance.now() - tTap0).toFixed(2));
        tapResult = { executed: true, ...target };

        const tActiveAfter0 = performance.now();
        activeAppAfter = readBundleInfo(await probeClient.wdaActiveAppInfo());
        activeAppAfterMs = Number((performance.now() - tActiveAfter0).toFixed(2));
      }
    }
  } finally {
    const tRel0 = performance.now();
    await runtime.leaseLifecycle.release!(lease);
    releaseMs = Number((performance.now() - tRel0).toFixed(2));

    const tShut0 = performance.now();
    await runtime.shutdown();
    shutdownMs = Number((performance.now() - tShut0).toFixed(2));
  }

  let activeAppAfterShutdown: WdaAttachSequenceResult['activeAppAfterShutdown'];
  let sessionPreserved = false;
  const tAfterShut0 = performance.now();
  try {
    activeAppAfterShutdown = readBundleInfo(await probeClient.wdaActiveAppInfo());
    sessionPreserved = true;
  } catch {
    sessionPreserved = false;
  }
  const activeAppAfterShutdownMs = Number((performance.now() - tAfterShut0).toFixed(2));

  return {
    endpoint: endpointStr,
    sessionId: options.sessionId,
    udid: options.udid,
    dryRun: Boolean(options.dryRun),
    ...(options.expectedBundleId ? { expectedBundleId: options.expectedBundleId } : {}),
    activeAppBefore,
    ...(activeAppAfter ? { activeAppAfter } : {}),
    ...(activeAppAfterShutdown ? { activeAppAfterShutdown } : {}),
    statusReady: typeof statusRes.ready === 'boolean' ? statusRes.ready : undefined,
    snapshot: {
      backend: snapshotResult.backend,
      producer: snapshotResult.producer,
      ...(snapshotResult.viewport ? { viewport: snapshotResult.viewport } : {}),
      nodeCount: snapshotNodes.length,
      sampleNodes: snapshotNodes.slice(0, 30).map((node) => ({
        ref: node.ref,
        ...(node.type ? { type: node.type } : {}),
        ...(node.label ? { label: node.label } : {}),
        ...(node.identifier ? { identifier: node.identifier } : {}),
        ...(node.rect ? { rect: node.rect } : {}),
      })),
    },
    ...(tapResult ? { tap: tapResult } : {}),
    screenshot: {
      path: options.screenshotPath,
      bytes: screenshotBytes,
    },
    sessionPreserved,
    timingsMs: {
      status: statusMs,
      activeAppBefore: activeAppBeforeMs,
      allocate: allocateMs,
      snapshot: snapshotMs,
      screenshot: screenshotMs,
      ...(tapMs !== undefined ? { tap: tapMs } : {}),
      ...(activeAppAfterMs !== undefined ? { activeAppAfter: activeAppAfterMs } : {}),
      release: releaseMs,
      shutdown: shutdownMs,
      activeAppAfterShutdown: activeAppAfterShutdownMs,
    },
  };
}
