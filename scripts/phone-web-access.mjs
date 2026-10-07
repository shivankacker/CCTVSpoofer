import { spawn } from 'node:child_process';
import { isIPv4 } from 'node:net';
import { pathToFileURL } from 'node:url';

const launcher = '/data/data/com.termux/files/home/cctvspoofer-native/phone-native.sh';

export function phoneWebAccessArguments(environment) {
  const destination = environment.BRIDGE_SSH_HOST;
  const lan = environment.PHONE_LAN_IP;
  const tailscale = environment.PHONE_TAILSCALE_IP;
  if (!destination || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(destination)) throw new Error('Set BRIDGE_SSH_HOST to the phone SSH alias.');
  if (!isIPv4(lan || '') || !isIPv4(tailscale || '')) throw new Error('Set PHONE_LAN_IP and PHONE_TAILSCALE_IP to IPv4 addresses.');
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', destination,
    `su -c "/system/bin/sh ${launcher} web-access ${tailscale} ${lan}"`];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = phoneWebAccessArguments(process.env);
    console.log(`Allowing http://${process.env.PHONE_LAN_IP}:3000 and http://${process.env.PHONE_TAILSCALE_IP}:3000, RTSP/ONVIF on ${process.env.PHONE_LAN_IP}; this restarts the phone server.`);
    const child = spawn('ssh', args, { stdio: 'inherit' });
    child.once('error', () => { console.error('Could not start SSH.'); process.exitCode = 1; });
    child.once('exit', (code) => { process.exitCode = code ?? 1; });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
