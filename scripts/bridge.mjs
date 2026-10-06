import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { configureCameraEnvironment, validateCameraConfig } from '../src/proxy-fleet.js';

export function renderEnvironment(template) {
  const values = {
    PROXY_USERNAME: 'proxyview', PROXY_PASSWORD: randomBytes(24).toString('hex'),
    DASHBOARD_PASSWORD: randomBytes(24).toString('hex'),
  };
  return template.replace(/^(?:PROXY_(USERNAME|PASSWORD)|DASHBOARD_PASSWORD)=.*$/gm, (line) => {
    const key = line.split('=')[0];
    const value = values[key];
    return `${key}='${value}'`;
  });
}

export function bridgeArguments(config, environment) {
  if (environment.CONNECTION_MODE !== 'bridge') throw new Error('Enable the bridge block in .env first.');
  const destination = environment.BRIDGE_SSH_HOST;
  if (!destination || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(destination)) throw new Error('Invalid SSH host alias.');
  const remotePort = Number(environment.OFFICE_RTSP_PORT || 554);
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new Error('Invalid office RTSP port.');
  const cameras = validateCameraConfig(configureCameraEnvironment(config, environment));
  const ports = new Set();
  const args = ['-NT', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  for (const camera of cameras) {
    if (!['127.0.0.1', 'localhost', 'host.docker.internal'].includes(camera.rtspHost)
      || !Number.isInteger(camera.rtspSourcePort) || camera.rtspSourcePort < 1024 || ports.has(camera.rtspSourcePort)) {
      throw new Error('Bridge cameras need a local connection host and unique unprivileged forwarding ports.');
    }
    ports.add(camera.rtspSourcePort);
    args.push('-L', `127.0.0.1:${camera.rtspSourcePort}:${camera.host}:${remotePort}`);
  }
  return [...args, destination];
}

async function main() {
  if (process.argv[2] === '--init-env') {
    const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
    await writeFile('.env', renderEnvironment(template), { flag: 'wx', mode: 0o600 });
    console.log('Created private .env with generated proxy and dashboard passwords. Set camera credentials and addresses before starting.');
    return;
  }
  if (process.argv.length > 2) throw new Error('Unknown bridge option.');
  const config = JSON.parse(await readFile(process.env.CAMERA_CONFIG_FILE || 'proxy-config.json', 'utf8'));
  const args = bridgeArguments(config, process.env);
  console.log('Opening localhost camera forwards through SSH. Leave this command running; Ctrl+C stops it.');
  const child = spawn('ssh', args, { stdio: 'inherit' });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  child.once('error', () => { console.error('Could not start SSH.'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = signal === 'SIGTERM' ? 0 : (code ?? 1); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Setup failed. Check .env, SSH access and forwarding ports. Initialization never overwrites an existing .env.');
    process.exitCode = 1;
  });
}