import onvif from 'onvif';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);

export function call(camera, method, ...args) {
  return new Promise((resolve, reject) => {
    camera[method](...args, (error, result) => error ? reject(error) : resolve(result));
  });
}

export function connect(hostname, credentials) {
  return new Promise((resolve, reject) => {
    const camera = new onvif.Cam({
      hostname, ...credentials, timeout: 8000, preserveAddress: true,
    }, (error) => error ? reject(error) : resolve(camera));
  });
}

export function environmentCredentials(environment, prefix) {
  const username = environment[`${prefix}_USERNAME`];
  const password = environment[`${prefix}_PASSWORD`];
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password
    || /[\r\n\0]/.test(username + password)) {
    throw new Error(`Set nonempty, single-line ${prefix}_USERNAME and ${prefix}_PASSWORD in the environment.`);
  }
  return { username, password };
}

export function cleanStreamUri(uri, hostname) {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'rtsp:' || parsed.hostname !== hostname) {
    throw new Error('Camera returned an unexpected stream host or protocol.');
  }
  parsed.username = '';
  parsed.password = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (/user|pass|token|auth/i.test(key)) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

export async function inspectCamera(camera, hostname) {
  const information = await call(camera, 'getDeviceInformation');
  const profiles = await call(camera, 'getProfiles');
  const streams = [];
  for (const profile of profiles) {
    const token = profile.$.token;
    const stream = await call(camera, 'getStreamUri', {
      protocol: 'RTSP', stream: 'RTP-Unicast', profileToken: token,
    });
    streams.push({
      token, name: profile.name,
      encoding: profile.videoEncoderConfiguration?.encoding,
      resolution: profile.videoEncoderConfiguration?.resolution,
      uri: cleanStreamUri(stream.uri, hostname),
    });
  }
  if (!streams.length) throw new Error('Camera returned no media profiles.');
  return { hostname, onvif: `http://${hostname}/onvif/device_service`, information, streams };
}

export async function retryRead(operation) {
  try {
    return await operation();
  } catch (error) {
    if (!/network timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(error.message)) throw error;
    return operation();
  }
}

async function readCamera(hostname, credentials) {
  return retryRead(async () => inspectCamera(await connect(hostname, credentials), hostname));
}

export async function verifyStream(uri, credentials) {
  const authenticated = new URL(uri);
  authenticated.username = credentials.username;
  authenticated.password = credentials.password;
  let stdout;
  try {
    ({ stdout } = await execute('ffprobe', [
      '-v', 'error', '-rtsp_transport', 'tcp', '-rw_timeout', '8000000',
      '-i', authenticated.toString(), '-select_streams', 'v:0',
      '-read_intervals', '%+2', '-count_packets',
      '-show_entries', 'stream=codec_name,width,height,nb_read_packets', '-of', 'json',
    ], { timeout: 25000, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('ffprobe is required for verify; install FFmpeg first.');
    throw new Error('RTSP verification failed or timed out; check viewer RTSP permissions and connectivity.');
  }
  const video = JSON.parse(stdout).streams?.[0];
  if (!video || !(Number(video.nb_read_packets) > 0)) {
    throw new Error('RTSP returned no video packets.');
  }
  return video;
}

function safeError(error, credentials) {
  let message = String(error.message).split('\n')[0];
  for (const credential of credentials) {
    if (credential?.password) message = message.replaceAll(credential.password, '[REDACTED]');
  }
  return message.replace(/rtsp:\/\/[^\s@]+@/g, 'rtsp://[REDACTED]@');
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    host: { type: 'string', multiple: true },
    output: { type: 'string', default: 'camera-inventory.json' },
    help: { type: 'boolean', default: false },
  } });
  const command = positionals[0] || 'inspect';
  if (values.help) {
    console.log('Usage: node --env-file=.env src/cameras.js [inspect|verify] --host IP [--host IP] [--output FILE]\n'
      + 'Requires CAMERA_USERNAME and CAMERA_PASSWORD. Read-only discovery; no camera settings or accounts are changed.');
    return;
  }
  if (!['inspect', 'verify'].includes(command) || positionals.length > 1) {
    throw new Error('Expected inspect or verify. Use --help.');
  }
  const hosts = [...new Set(values.host || (environment.CAMERA_HOST ? [environment.CAMERA_HOST] : []))];
  if (!hosts.length || hosts.some((host) => isIP(host) !== 4)) throw new Error('Provide camera IPv4 addresses with --host.');
  const credentials = environmentCredentials(environment, 'CAMERA');
  const results = [];
  for (const hostname of hosts) {
    try {
      const result = await readCamera(hostname, credentials);
      if (command === 'verify') {
        for (const stream of result.streams) {
          stream.verification = await verifyStream(stream.uri, credentials);
        }
      }
      results.push(result);
      console.log(`${hostname}: ${result.streams.length} streams ${command === 'verify' ? 'receiving video' : 'discovered'}`);
    } catch (error) {
      results.push({ hostname, error: safeError(error, [credentials]) });
      console.error(`${hostname}: ${results.at(-1).error}`);
      process.exitCode = 1;
    }
  }
  await writeFile(values.output, `${JSON.stringify({
    checkedAt: new Date().toISOString(), username: credentials.username, cameras: results,
  }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Credential-free inventory: ${values.output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(safeError(error, [{ password: process.env.CAMERA_PASSWORD }]));
    process.exitCode = 1;
  });
}