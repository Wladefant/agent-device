import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCloudWebDriverRuntime } from './runtime.ts';
import { consumeAllProfileFields } from './profile-fields.fixtures.ts';
import { AppError } from '@agent-device/kernel/errors';
import { createWdaAttachRuntime, runWdaAttachSequence } from './wda-attach.ts';
import { WebDriverClient } from './webdriver-client.ts';

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

test('WDA attach sequence reuses existing session, routes WDA endpoints, and never creates or deletes session', async () => {
  await withMockWdaServer('com.wladefant.heylolo.dev', async ({ endpoint, requests }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wda-attach-test-'));
    const shotPath = path.join(tmpDir, 'shot.png');
    try {
      const result = await runWdaAttachSequence({
        endpoint,
        sessionId: 'SESS-1',
        udid: 'UDID-1',
        expectedBundleId: 'com.wladefant.heylolo.dev',
        screenshotPath: shotPath,
        tap: { kind: 'label', label: 'Home', type: 'XCUIElementTypeButton' },
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
      assert.equal(
        requests.some(
          (r) =>
            r.method === 'POST' &&
            r.url === '/session/SESS-1/wda/tap' &&
            JSON.stringify(r.body) === '{"x":73,"y":792}',
        ),
        true,
      );
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
      backend: 'ios-device' as const,
      deviceKey: 'wda-attach:UDID-1',
      createdAt: 1,
      expiresAt: 2,
      heartbeatAt: 1,
    };
    const device = {
      platform: 'ios' as const,
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
      await interactor.home();
      await interactor.close('com.wladefant.heylolo.dev');
      await runtime.leaseLifecycle.release!(lease);
    } finally {
      await runtime.shutdown();
    }

    assert.deepEqual(
      requests.map((r) => `${r.method} ${r.url}`),
      [
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
            backend: 'ios-device',
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
