import test from 'node:test';
import assert from 'node:assert/strict';
import { environmentCredentials, cleanStreamUri, retryRead, inspectCamera, main } from '../src/cameras.js';

test('credentials require complete environment values without accepting control characters', () => {
  for (const prefix of ['CAMERA', 'PROXY']) {
    assert.throws(() => environmentCredentials({}, prefix), new RegExp(prefix + '_PASSWORD'));
    for (const password of ['', undefined, 123, 'bad\nvalue', 'bad\0value']) {
      assert.throws(() => environmentCredentials({ [`${prefix}_USERNAME`]: 'viewer', [`${prefix}_PASSWORD`]: password }, prefix));
    }
    assert.deepEqual(environmentCredentials({ [`${prefix}_USERNAME`]: 'viewer', [`${prefix}_PASSWORD`]: 'literal$#= secret' }, prefix),
      { username: 'viewer', password: 'literal$#= secret' });
  }
});

test('discovery requires explicit hosts and credentials before contacting cameras', async () => {
  await assert.rejects(main(['inspect'], {}), /--host/);
  await assert.rejects(main(['inspect', '--host', 'not-an-ip'], {}), /IPv4/);
  await assert.rejects(main(['inspect', '--host', '192.0.2.10'], {}), /CAMERA_PASSWORD/);
  await assert.rejects(main(['provision'], {}), /Expected inspect or verify/);
});

test('inventory URIs exclude credentials and cannot point at the NVR or another host', () => {
  assert.equal(cleanStreamUri('rtsp://admin:secret@192.168.1.12:554/cam/realmonitor?channel=1&subtype=0&password=secret', '192.168.1.12'),
    'rtsp://192.168.1.12:554/cam/realmonitor?channel=1&subtype=0');
  assert.throws(() => cleanStreamUri('rtsp://192.168.1.111/video', '192.168.1.12'));
  assert.throws(() => cleanStreamUri('http://192.168.1.12/video', '192.168.1.12'));
});

test('read retries are bounded and never retry authentication errors', async () => {
  let attempts = 0;
  assert.equal(await retryRead(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Network timeout');
    return 'connected';
  }), 'connected');
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(retryRead(async () => {
    attempts += 1;
    throw new Error('Network timeout');
  }), /Network timeout/);
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(retryRead(async () => {
    attempts += 1;
    throw new Error('NotAuthorized');
  }), /NotAuthorized/);
  assert.equal(attempts, 1);
});

test('discovery requests every profile and records direct credential-free RTSP addresses', async () => {
  const tokens = [];
  const camera = {
    getDeviceInformation(callback) { callback(null, { manufacturer: 'CPPLUS' }); },
    getProfiles(callback) {
      callback(null, ['Profile000', 'Profile001'].map((token) => ({
        $: { token }, name: token, videoEncoderConfiguration: { encoding: 'H265' },
      })));
    },
    getStreamUri(options, callback) {
      tokens.push(options.profileToken);
      callback(null, { uri: `rtsp://192.168.1.12/video/live?subtype=${tokens.length - 1}` });
    },
  };
  const result = await inspectCamera(camera, '192.168.1.12');
  assert.deepEqual(tokens, ['Profile000', 'Profile001']);
  assert.equal(result.streams.length, 2);
  assert.equal(result.streams[0].encoding, 'H265');
  assert.equal(result.onvif, 'http://192.168.1.12/onvif/device_service');
});