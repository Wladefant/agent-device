import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createCloudWebDriverRuntime } from './runtime.ts';
import { consumeAllProfileFields } from './profile-fields.fixtures.ts';
import { AppError } from '@agent-device/kernel/errors';
import { createWdaAttachRuntime, runWdaAttachSequence } from './wda-attach.ts';
import { WebDriverClient } from './webdriver-client.ts';

const execFileAsync = promisify(execFile);

const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const SAMPLE_WDA_XML = `<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Hey LoLo" label="Hey LoLo" enabled="true" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeTabBar type="XCUIElementTypeTabBar" name="Tab Bar" label="Tab Bar" enabled="true" visible="true" x="0" y="761" width="390" height="83">
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="Home" label="Home" enabled="true" visible="true" x="25" y="765" width="96" height="54" />
    </XCUIElementTypeTabBar>
  </XCUIElementTypeApplication>
</AppiumAUT>`;

async function withMockWdaServer(
  bundleId: string,
  fn: (ctx: {
    endpoint: string;
    requests: Array<{ method: string; url: string; body: unknown }>;
  }) => Promise<void>,
) {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body });
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/status') {
      res.end(JSON.stringify({ value: { ready: true, state: 'success' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/session/SESS-1/wda/activeAppInfo') {
      res.end(JSON.stringify({ value: { bundleId, name: 'Hey LoLo', pid: 42 } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/session/SESS-1/source') {
      res.end(JSON.stringify({ value: SAMPLE_WDA_XML }));
      return;
    }
    if (req.method === 'GET' && req.url === '/session/SESS-1/screenshot') {
      res.end(JSON.stringify({ value: PNG_1X1_B64 }));
      return;
    }
    if (
      req.method === 'POST' &&
      (req.url === '/session/SESS-1/wda/tap' ||
        req.url === '/session/SESS-1/wda/apps/activate' ||
        req.url === '/session/SESS-1/wda/apps/terminate' ||
        req.url === '/wda/homescreen')
    ) {
      res.end(JSON.stringify({ value: null }));
      return;
    }
    res.statusCode = 404;
    res.end(
      JSON.stringify({ value: { error: 'unknown command', message: `Unhandled ${req.method} ${req.url}` } }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ endpoint, requests });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test('WDA attach sequence reuses existing session, delegates tap to owner guard, and never creates or deletes session', async () => {
  await withMockWdaServer('com.wladefant.heylolo.dev', async ({ endpoint, requests }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wda-attach-test-'));
    const shotPath = path.join(tmpDir, 'shot.png');
    const guardedCalls: Array<{
      sessionId: string;
      x: number;
      y: number;
      leaseId?: string;
      deviceId?: string;
      hasSignal: boolean;
    }> = [];
    try {
      const result = await runWdaAttachSequence({
        endpoint,
        sessionId: 'SESS-1',
        udid: 'UDID-1',
        expectedBundleId: 'com.wladefant.heylolo.dev',
        screenshotPath: shotPath,
        tap: { kind: 'label', label: 'Home', type: 'XCUIElementTypeButton' },
        guardedWdaTap: async (request) => {
          guardedCalls.push({
            sessionId: request.sessionId,
            x: request.x,
            y: request.y,
            leaseId: request.leaseId,
            deviceId: request.deviceId,
            hasSignal: request.signal instanceof AbortSignal,
          });
        },
      });

      assert.equal(result.statusReady, true);
      assert.equal(result.sessionPreserved, true);
      assert.equal(result.snapshot.backend, 'xctest');
      assert.equal(result.snapshot.producer, 'appium-source');
      assert.deepEqual(result.snapshot.viewport, { width: 390, height: 844 });
      assert.ok(result.snapshot.nodeCount >= 3);
      assert.deepEqual(result.tap, {
        executed: true,
        targetRef: 'e3',
        targetLabel: 'Home',
        x: 73,
        y: 792,
      });
      const pngBytes = await fs.readFile(shotPath);
      assert.equal(pngBytes.subarray(0, 4).toString('hex'), '89504e47');

      assert.equal(requests.some((r) => r.method === 'POST' && r.url === '/session'), false);
      assert.equal(requests.some((r) => r.method === 'DELETE' && r.url.startsWith('/session/')), false);
      assert.equal(requests.some((r) => r.url.includes('/appium/device/is_keyboard_shown')), false);
      assert.equal(requests.some((r) => r.url.includes('/wda/tap')), false);
      assert.equal(requests.some((r) => r.url.includes('/actions')), false);
      assert.deepEqual(guardedCalls, [
        {
          sessionId: 'SESS-1',
          x: 73,
          y: 792,
          leaseId: 'wda-attach-SESS-1',
          deviceId: 'UDID-1',
          hasSignal: true,
        },
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test('WDA routeProfile routes open, close, and home to WDA endpoints', async () => {
  await withMockWdaServer('com.wladefant.heylolo.dev', async ({ endpoint, requests }) => {
    const runtime = createWdaAttachRuntime({ endpoint, sessionId: 'SESS-1', udid: 'UDID-1' });
    const lease = {
      leaseId: 'lease-wda-1',
      tenantId: 't1',
      runId: 'r1',
      clientId: 'c1',
      leaseProvider: 'wda-attach',
      backend: 'ios-instance' as const,
      deviceKey: 'wda-attach:UDID-1',
      createdAt: 1,
      expiresAt: 2,
      heartbeatAt: 1,
    };
    const device = {
      platform: 'apple' as const,
      target: 'mobile' as const,
      appleOs: 'ios' as const,
      id: 'UDID-1',
      name: 'Attached iOS Device',
      kind: 'device' as const,
      booted: true,
    };
    try {
      await runtime.leaseLifecycle.allocate!(lease);
      const interactor = runtime.getInteractor(device)!;
      await interactor.open('com.wladefant.heylolo.dev');
      await interactor.home!();
      await interactor.close('com.wladefant.heylolo.dev');
      await runtime.leaseLifecycle.release!(lease);
    } finally {
      await runtime.shutdown();
    }

    assert.deepEqual(
      requests.map((r) => `${r.method} ${r.url}`),
      [
        'GET /session/SESS-1/wda/activeAppInfo',
        'POST /session/SESS-1/wda/apps/activate',
        'POST /wda/homescreen',
        'POST /session/SESS-1/wda/apps/terminate',
      ],
    );
  });
});

test('WDA attach refuses foreground bundle mismatch and invalid attachSession args', async () => {
  const client = new WebDriverClient({ clientVersion: 'test', endpoint: 'http://127.0.0.1:18100' });
  assert.throws(
    () => client.attachSession('   '),
    (err: unknown) => err instanceof AppError && err.code === 'INVALID_ARGS',
  );

  await withMockWdaServer('com.apple.springboard', async ({ endpoint, requests }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wda-attach-mismatch-'));
    try {
      await assert.rejects(
        () =>
          runWdaAttachSequence({
            endpoint,
            sessionId: 'SESS-1',
            udid: 'UDID-1',
            expectedBundleId: 'com.wladefant.heylolo.dev',
            screenshotPath: path.join(tmpDir, 'shot.png'),
            tap: { kind: 'point', x: 73, y: 792 },
            guardedWdaTap: async () => {},
          }),
        (err: unknown) => err instanceof AppError && /Foreground app mismatch/.test(err.message),
      );
      assert.equal(requests.some((r) => r.url.includes('/wda/tap')), false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test('WDA attach refuses existingSessionId with sessionOwnership=owned and attached deleteSession sends no DELETE', async () => {
  await withMockWdaServer('com.wladefant.heylolo.dev', async ({ endpoint, requests }) => {
    const client = new WebDriverClient({ clientVersion: 'test', endpoint });
    client.attachSession('SESS-1');
    await client.deleteSession();
    assert.equal(requests.length, 0);

    const runtime = createCloudWebDriverRuntime({
      clientVersion: 'test',
      provider: 'wda-attach',
      endpoint,
      platform: 'ios',
      deviceName: 'Attached iOS',
      profileFields: consumeAllProfileFields('wda-attach'),
      existingSessionId: 'SESS-1',
      sessionOwnership: 'owned',
    });
    try {
      await assert.rejects(
        () =>
          runtime.leaseLifecycle.allocate!({
            leaseId: 'lease-bad-1',
            tenantId: 't1',
            runId: 'r1',
            clientId: 'c1',
            leaseProvider: 'wda-attach',
            backend: 'ios-instance',
            deviceKey: 'wda-attach:UDID-1',
            createdAt: 1,
            expiresAt: 2,
            heartbeatAt: 1,
          }),
        (err: unknown) => err instanceof AppError && err.code === 'INVALID_ARGS',
      );
    } finally {
      await runtime.shutdown();
    }
  });
});

for (const refuse of [false, true]) {
  test(`WDA tap delegates to the owner guard without raw fallback when guard ${refuse ? 'refuses' : 'accepts'}`, async () => {
    await withMockWdaServer('com.wladefant.heylolo.dev', async ({ endpoint, requests }) => {
      const guarded: Array<{
        sessionId: string;
        x: number;
        y: number;
        leaseId?: string;
        deviceId?: string;
        hasSignal: boolean;
      }> = [];
      const runtime = createWdaAttachRuntime({
        endpoint,
        sessionId: 'SESS-1',
        udid: 'UDID-1',
        guardedWdaTap: async (request) => {
          guarded.push({
            sessionId: request.sessionId,
            x: request.x,
            y: request.y,
            leaseId: request.leaseId,
            deviceId: request.deviceId,
            hasSignal: request.signal instanceof AbortSignal,
          });
          if (refuse) throw new Error('owner guard refused notification banner');
        },
      });
      const lease = {
        leaseId: 'guarded-lease',
        tenantId: 't1',
        runId: 'r1',
        clientId: 'c1',
        leaseProvider: 'wda-attach',
        backend: 'ios-instance' as const,
        deviceKey: 'wda-attach:UDID-1',
        createdAt: 1,
        expiresAt: 2,
        heartbeatAt: 1,
      };
      const device = {
        platform: 'apple' as const,
        target: 'mobile' as const,
        appleOs: 'ios' as const,
        id: 'UDID-1',
        name: 'Attached iOS Device',
        kind: 'device' as const,
        booted: true,
      };
      try {
        await runtime.leaseLifecycle.allocate!(lease);
        const interactor = runtime.getInteractor(device)!;
        if (refuse) {
          await assert.rejects(() => interactor.tap(73, 792), /owner guard refused/);
        } else {
          await interactor.tap(73, 792);
        }
        assert.deepEqual(guarded, [
          {
            sessionId: 'SESS-1',
            x: 73,
            y: 792,
            leaseId: 'guarded-lease',
            deviceId: 'UDID-1',
            hasSignal: true,
          },
        ]);
      } finally {
        await runtime.shutdown();
      }
      assert.deepEqual(
        requests.map((r) => `${r.method} ${r.url}`),
        ['GET /session/SESS-1/wda/activeAppInfo'],
      );
    });
  });
}

test('legacy WebDriverClient.wdaTap without guard still dispatches POST /session/{id}/wda/tap', async () => {
  await withMockWdaServer('com.wladefant.heylolo.dev', async ({ endpoint, requests }) => {
    const client = new WebDriverClient({ clientVersion: 'test', endpoint });
    client.attachSession('SESS-1');
    await client.wdaTap(73, 792);
    assert.deepEqual(requests, [
      { method: 'POST', url: '/session/SESS-1/wda/tap', body: { x: 73, y: 792 } },
    ]);
  });
});

test('WDA attach refuses stale session during allocate without POST or DELETE /session', async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/' });
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        value: { error: 'invalid session id', message: 'Session does not exist' },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const runtime = createWdaAttachRuntime({ endpoint, sessionId: 'STALE-1', udid: 'UDID-1' });
  const lease = {
    leaseId: 'stale-lease',
    tenantId: 't1',
    runId: 'r1',
    clientId: 'c1',
    leaseProvider: 'wda-attach',
    backend: 'ios-instance' as const,
    deviceKey: 'wda-attach:UDID-1',
    createdAt: 1,
    expiresAt: 2,
    heartbeatAt: 1,
  };
  const device = {
    platform: 'apple' as const,
    target: 'mobile' as const,
    appleOs: 'ios' as const,
    id: 'UDID-1',
    name: 'Attached iOS Device',
    kind: 'device' as const,
    booted: true,
  };
  try {
    await assert.rejects(
      () => runtime.leaseLifecycle.allocate!(lease),
      (err: unknown) => err instanceof AppError && err.code === 'SESSION_NOT_FOUND',
    );
    assert.equal(await runtime.leaseLifecycle.heartbeat!(lease), undefined);
    assert.equal(runtime.getInteractor(device), undefined);
    assert.deepEqual(requests, [{ method: 'GET', url: '/session/STALE-1/wda/activeAppInfo' }]);
  } finally {
    await runtime.shutdown();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('WDA attach enforces single active lease per session/device and allows post-release reallocation', async () => {
  await withMockWdaServer('com.wladefant.heylolo.dev', async ({ endpoint }) => {
    const seenLeaseIds: string[] = [];
    const runtime = createWdaAttachRuntime({
      endpoint,
      sessionId: 'SESS-1',
      udid: 'UDID-1',
      guardedWdaTap: async (request) => {
        if (request.leaseId) seenLeaseIds.push(request.leaseId);
      },
    });
    const makeAttachLease = (leaseId: string) => ({
      leaseId,
      tenantId: 't1',
      runId: 'r1',
      clientId: 'c1',
      leaseProvider: 'wda-attach',
      backend: 'ios-instance' as const,
      deviceKey: 'wda-attach:UDID-1',
      createdAt: 1,
      expiresAt: 2,
      heartbeatAt: 1,
    });
    const device = {
      platform: 'apple' as const,
      target: 'mobile' as const,
      appleOs: 'ios' as const,
      id: 'UDID-1',
      name: 'Attached iOS Device',
      kind: 'device' as const,
      booted: true,
    };
    const leaseA = makeAttachLease('attach-lease-a');
    const leaseB = makeAttachLease('attach-lease-b');
    try {
      const [resA, resB] = await Promise.allSettled([
        runtime.leaseLifecycle.allocate!(leaseA),
        runtime.leaseLifecycle.allocate!(leaseB),
      ]);
      const winner = resA.status === 'fulfilled' ? leaseA : leaseB;
      const loser = resA.status === 'fulfilled' ? leaseB : leaseA;
      const rejected = resA.status === 'rejected' ? resA : resB;
      assert.equal([resA, resB].filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(rejected.status, 'rejected');
      assert.ok(rejected.reason instanceof AppError && rejected.reason.code === 'DEVICE_IN_USE');

      await runtime.getInteractor(device)!.tap(73, 792);
      await runtime.leaseLifecycle.release!(winner);
      await runtime.leaseLifecycle.allocate!(loser);
      await runtime.getInteractor(device)!.tap(73, 792);
      assert.deepEqual(seenLeaseIds, [winner.leaseId, loser.leaseId]);
    } finally {
      await runtime.shutdown();
    }
  });
});

test('WDA attach release cancels stalled guardedWdaTap immediately', async () => {
  await withMockWdaServer('com.wladefant.heylolo.dev', async ({ endpoint }) => {
    let guardSignal: AbortSignal | undefined;
    let guardStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      guardStarted = resolve;
    });
    const runtime = createWdaAttachRuntime({
      endpoint,
      sessionId: 'SESS-1',
      udid: 'UDID-1',
      requestPolicy: { timeoutMs: 30_000, retryAttempts: 0 },
      guardedWdaTap: async (request) => {
        guardSignal = request.signal;
        guardStarted();
        return await new Promise<void>(() => {});
      },
    });
    const lease = {
      leaseId: 'cancel-lease',
      tenantId: 't1',
      runId: 'r1',
      clientId: 'c1',
      leaseProvider: 'wda-attach',
      backend: 'ios-instance' as const,
      deviceKey: 'wda-attach:UDID-1',
      createdAt: 1,
      expiresAt: 2,
      heartbeatAt: 1,
    };
    const device = {
      platform: 'apple' as const,
      target: 'mobile' as const,
      appleOs: 'ios' as const,
      id: 'UDID-1',
      name: 'Attached iOS Device',
      kind: 'device' as const,
      booted: true,
    };
    try {
      await runtime.leaseLifecycle.allocate!(lease);
      const tapPromise = runtime.getInteractor(device)!.tap(73, 792);
      await started;
      await runtime.leaseLifecycle.release!(lease);
      await assert.rejects(
        () => tapPromise,
        (err: unknown) =>
          err instanceof AppError &&
          err.details?.dispatched === 'unknown' &&
          err.details?.retriable === false,
      );
      assert.equal(guardSignal?.aborted, true);
    } finally {
      await runtime.shutdown();
    }
  });
});

test('WDA attach sequence requires owner guard for live tap, rejects app switch and stale/ambiguous targets before tap, and checks coordinates', async () => {
  let activeBundle = 'com.wladefant.heylolo.dev';
  let xmlPayload = SAMPLE_WDA_XML;
  let onScreenshot: (() => void) | undefined;
  const requests: Array<{ method: string; url: string }> = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/' });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/status') {
      res.end(JSON.stringify({ value: { ready: true } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/session/SESS-1/wda/activeAppInfo') {
      res.end(JSON.stringify({ value: { bundleId: activeBundle, name: 'App', pid: 42 } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/session/SESS-1/source') {
      res.end(JSON.stringify({ value: xmlPayload }));
      return;
    }
    if (req.method === 'GET' && req.url === '/session/SESS-1/screenshot') {
      onScreenshot?.();
      res.end(JSON.stringify({ value: PNG_1X1_B64 }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ value: { error: 'unknown command', message: 'unhandled' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wda-seq-guard-'));
  const shotPath = path.join(tmpDir, 'shot.png');
  try {
    // 1. Live tap without guardedWdaTap is refused.
    await assert.rejects(
      () =>
        runWdaAttachSequence({
          endpoint,
          sessionId: 'SESS-1',
          udid: 'UDID-1',
          expectedBundleId: 'com.wladefant.heylolo.dev',
          screenshotPath: shotPath,
          tap: { kind: 'point', x: 73, y: 792 },
        }),
      (err: unknown) =>
        err instanceof AppError && err.details?.reason === 'wda_tap_guard_required',
    );

    // 2. Malformed / negative / out-of-viewport coordinates are refused before guard.
    for (const badTap of [
      { kind: 'point' as const, x: Number.NaN, y: 10 },
      { kind: 'point' as const, x: -5, y: 10 },
      { kind: 'point' as const, x: 500, y: 10 },
    ]) {
      let guardCalled = false;
      await assert.rejects(
        () =>
          runWdaAttachSequence({
            endpoint,
            sessionId: 'SESS-1',
            udid: 'UDID-1',
            expectedBundleId: 'com.wladefant.heylolo.dev',
            screenshotPath: shotPath,
            tap: badTap,
            guardedWdaTap: async () => {
              guardCalled = true;
            },
          }),
        (err: unknown) => err instanceof AppError && err.code === 'INVALID_ARGS',
      );
      assert.equal(guardCalled, false);
    }

    // 3. App switch between snapshot and tap dispatch is caught before owner guard executes.
    let guardCalledOnSwitch = false;
    activeBundle = 'com.wladefant.heylolo.dev';
    xmlPayload = SAMPLE_WDA_XML;
    onScreenshot = () => {
      activeBundle = 'com.apple.springboard';
    };
    await assert.rejects(
      () =>
        runWdaAttachSequence({
          endpoint,
          sessionId: 'SESS-1',
          udid: 'UDID-1',
          expectedBundleId: 'com.wladefant.heylolo.dev',
          screenshotPath: shotPath,
          tap: { kind: 'label', label: 'Home', type: 'XCUIElementTypeButton' },
          guardedWdaTap: async () => {
            guardCalledOnSwitch = true;
          },
        }),
      (err: unknown) =>
        err instanceof AppError && err.details?.reason === 'wda_foreground_app_mismatch',
    );
    assert.equal(guardCalledOnSwitch, false);

    // 4. Target becoming disabled or invisible between snapshot and tap is caught before owner guard executes.
    let guardCalledOnDisabled = false;
    activeBundle = 'com.wladefant.heylolo.dev';
    xmlPayload = SAMPLE_WDA_XML;
    onScreenshot = () => {
      xmlPayload = SAMPLE_WDA_XML.replace('enabled="true" visible="true" x="25"', 'enabled="false" visible="true" x="25"');
    };
    await assert.rejects(
      () =>
        runWdaAttachSequence({
          endpoint,
          sessionId: 'SESS-1',
          udid: 'UDID-1',
          expectedBundleId: 'com.wladefant.heylolo.dev',
          screenshotPath: shotPath,
          tap: { kind: 'label', label: 'Home', type: 'XCUIElementTypeButton' },
          guardedWdaTap: async () => {
            guardCalledOnDisabled = true;
          },
        }),
      (err: unknown) => err instanceof AppError && err.code === 'COMMAND_FAILED',
    );
    assert.equal(guardCalledOnDisabled, false);

    // 5. Ambiguous visible enabled label targets are refused with AMBIGUOUS_MATCH.
    activeBundle = 'com.wladefant.heylolo.dev';
    onScreenshot = undefined;
    xmlPayload = `<AppiumAUT>
      <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Hey LoLo" label="Hey LoLo" enabled="true" visible="true" x="0" y="0" width="390" height="844">
        <XCUIElementTypeButton type="XCUIElementTypeButton" name="Home" label="Home" enabled="true" visible="true" x="25" y="765" width="96" height="54" />
        <XCUIElementTypeButton type="XCUIElementTypeButton" name="Home" label="Home" enabled="true" visible="true" x="150" y="765" width="96" height="54" />
      </XCUIElementTypeApplication>
    </AppiumAUT>`;
    await assert.rejects(
      () =>
        runWdaAttachSequence({
          endpoint,
          sessionId: 'SESS-1',
          udid: 'UDID-1',
          expectedBundleId: 'com.wladefant.heylolo.dev',
          screenshotPath: shotPath,
          dryRun: true,
          tap: { kind: 'label', label: 'Home', type: 'XCUIElementTypeButton' },
        }),
      (err: unknown) => err instanceof AppError && err.code === 'AMBIGUOUS_MATCH',
    );

    // 6. Target becoming invisible or shifting before tap dispatch is refused before guard.
    let guardCalledOnInvisible = false;
    activeBundle = 'com.wladefant.heylolo.dev';
    xmlPayload = SAMPLE_WDA_XML;
    onScreenshot = () => {
      xmlPayload = SAMPLE_WDA_XML.replace('enabled="true" visible="true" x="25"', 'enabled="true" visible="false" x="25"');
    };
    await assert.rejects(
      () =>
        runWdaAttachSequence({
          endpoint,
          sessionId: 'SESS-1',
          udid: 'UDID-1',
          expectedBundleId: 'com.wladefant.heylolo.dev',
          screenshotPath: shotPath,
          tap: { kind: 'label', label: 'Home', type: 'XCUIElementTypeButton' },
          guardedWdaTap: async () => {
            guardCalledOnInvisible = true;
          },
        }),
      (err: unknown) => err instanceof AppError && err.code === 'COMMAND_FAILED',
    );
    assert.equal(guardCalledOnInvisible, false);

    let guardCalledOnShift = false;
    xmlPayload = SAMPLE_WDA_XML;
    onScreenshot = () => {
      xmlPayload = SAMPLE_WDA_XML.replace('x="25" y="765"', 'x="45" y="765"');
    };
    await assert.rejects(
      () =>
        runWdaAttachSequence({
          endpoint,
          sessionId: 'SESS-1',
          udid: 'UDID-1',
          expectedBundleId: 'com.wladefant.heylolo.dev',
          screenshotPath: shotPath,
          tap: { kind: 'label', label: 'Home', type: 'XCUIElementTypeButton' },
          guardedWdaTap: async () => {
            guardCalledOnShift = true;
          },
        }),
      (err: unknown) => err instanceof AppError && err.details?.reason === 'wda_tap_target_shifted',
    );
    assert.equal(guardCalledOnShift, false);

    // 7. dryRun: true validates target without requiring guardedWdaTap or executing tap.
    xmlPayload = SAMPLE_WDA_XML;
    onScreenshot = undefined;
    const dryRunResult = await runWdaAttachSequence({
      endpoint,
      sessionId: 'SESS-1',
      udid: 'UDID-1',
      expectedBundleId: 'com.wladefant.heylolo.dev',
      screenshotPath: shotPath,
      dryRun: true,
      tap: { kind: 'label', label: 'Home', type: 'XCUIElementTypeButton' },
    });
    assert.equal(dryRunResult.tap?.executed, false);
    assert.equal(dryRunResult.tap?.x, 73);
    assert.equal(dryRunResult.tap?.y, 792);
    assert.equal(requests.some((r) => r.url.includes('/wda/tap') || r.url.includes('/actions')), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('WDA workspace loaders enforce Node >=22.18 floor and pilot CLI rejects malformed tap flags', async () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  assert.equal(pkg.engines?.node, '>=22.18');

  // Test exercises the workspace loader boundary dynamically via pathToFileURL.
  const hooks = (await import(
    pathToFileURL(path.join(repoRoot, 'scripts/wda-workspace-hooks.mjs')).href
  )) as {
    isSupportedWdaLoaderNodeVersion: (v: string) => boolean;
    assertSupportedWdaLoaderRuntime: (opts?: { nodeVersion?: string; registerHooks?: unknown }) => void;
  };
  assert.equal(hooks.isSupportedWdaLoaderNodeVersion('22.12.0'), false);
  assert.equal(hooks.isSupportedWdaLoaderNodeVersion('22.14.0'), false);
  assert.equal(hooks.isSupportedWdaLoaderNodeVersion('22.17.9'), false);
  assert.equal(hooks.isSupportedWdaLoaderNodeVersion('22.18.0'), true);
  assert.equal(hooks.isSupportedWdaLoaderNodeVersion('24.12.0'), true);
  assert.throws(() => hooks.assertSupportedWdaLoaderRuntime({ nodeVersion: '22.12.0' }), />=22\.18/);
  assert.throws(
    () => hooks.assertSupportedWdaLoaderRuntime({ nodeVersion: '22.18.0', registerHooks: undefined }),
    /registerHooks/,
  );

  const smoke = await execFileAsync(
    process.execPath,
    [
      '--import',
      pathToFileURL(path.join(repoRoot, 'scripts/wda-workspace-hooks.mjs')).href,
      '--input-type=module',
      '-e',
      "const mod = await import('@agent-device/provider-webdriver/wda-attach'); if (typeof mod.runWdaAttachSequence !== 'function') throw new Error('missing export');",
    ],
    { cwd: repoRoot },
  );
  assert.equal(smoke.stderr, '');

  for (const badArgs of [
    ['--session', 'SESS-1', '--tap-x', 'abc', '--tap-y', '10', '--dry-run'],
    ['--session', 'SESS-1', '--tap-x', '-1', '--tap-y', '10', '--dry-run'],
    ['--session', 'SESS-1', '--tap-x', '10', '--dry-run'],
    ['--session', 'SESS-1', '--tap-label', 'Home', '--tap-x', '10', '--tap-y', '20', '--dry-run'],
  ]) {
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [path.join(repoRoot, 'scripts/wda-attach-pilot.mjs'), ...badArgs],
          { cwd: repoRoot },
        ),
      (err: unknown) => typeof err === 'object' && err !== null && 'code' in err,
    );
  }
});
