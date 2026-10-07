import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);

async function fixture(context, { vpn = 'null', lockdown = 'null', appRunning = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'phone-boot-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const prefix = join(root, 'termux/usr');
  const native = join(root, 'termux/home/cctvspoofer-native');
  const boot = join(root, 'adb/cctvspoofer');
  const hook = join(root, 'adb/service.d/90-cctvspoofer.sh');
  const events = join(root, 'events');
  const ready = join(root, 'ready');
  const settings = join(root, 'settings');
  for (const directory of [join(prefix, 'bin'), join(prefix, 'var/run'), join(native, 'rootfs'),
    join(root, 'system/bin'), join(root, 'adb/service.d'), join(root, 'dev'), settings]) {
    await mkdir(directory, { recursive: true });
  }
  await symlink('/bin/sh', join(root, 'system/bin/sh'));
  await writeFile(join(native, 'rootfs/.cctvspoofer-installed'), '10166\n');
  await writeFile(events, '');
  await writeFile(ready, 'true\n');
  await writeFile(join(settings, 'always_on_vpn_app'), vpn);
  await writeFile(join(settings, 'always_on_vpn_lockdown'), lockdown);
  const stub = (name, body) => writeFile(join(prefix, 'bin', name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
  await stub('id', 'printf "0\\n"');
  await stub('su', 'printf "su %s\\n" "$*" >> "$EVENTS"');
  await stub('pm', 'printf "package:/fixture/tailscale.apk\\n"');
  await stub('settings', `shift 2
case "$1" in
  get) if test -f "$SETTINGS/$3"; then cat "$SETTINGS/$3"; else printf null; fi ;;
  put) printf '%s' "$4" > "$SETTINGS/$3"; printf 'setting %s\\n' "$3" >> "$EVENTS" ;;
  delete) rm -f "$SETTINGS/$3" ;;
  *) exit 1 ;;
esac`);
  await stub('getprop', 'case "$1" in sys.boot_completed) printf 1 ;; sys.user.0.ce_available) cat "$READY" ;; *) exit 1 ;; esac');
  await writeFile(join(root, 'system/bin/sleep'), '#!/bin/sh\nprintf "wait\\n" >> "$EVENTS"\nprintf "true\\n" > "$READY"\n', { mode: 0o700 });
  await stub('sv', `case "$1:$2" in
  status:*/rootfs/*) test "$APP_RUNNING" = true ;;
  status:*) exit 1 ;;
  up:*) printf 'sv-up %s\\n' "$2" >> "$EVENTS" ;;
  *) exit 1 ;;
esac`);
  await stub('nohup', 'printf "launch base=%s %s\\n" "${CCTVSPOOFER_BASE:-none}" "$*" >> "$EVENTS"');
  for (const name of ['sshd', 'runsv', 'svlogd']) await stub(name, 'exit 99');
  for (const name of ['phone-boot.sh', 'phone-native.sh']) {
    const original = await readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
    const mapped = original.replaceAll('/data/data/com.termux/files', join(root, 'termux'))
      .replaceAll('/data/adb', join(root, 'adb')).replaceAll('/system/bin', join(root, 'system/bin'))
      .replaceAll('/dev/.cctvspoofer-boot-lock', join(root, 'dev/.cctvspoofer-boot-lock'))
      .replaceAll('/proc/', join(root, 'proc/'))
      .replace(/^(export .*PATH=.*)$/m, '$1\nPATH="$PATH:$FIXTURE_PATH"');
    await writeFile(join(native, name), `${mapped}\nwait\n`, { mode: 0o700 });
  }
  return { root, prefix, native, boot, hook, ready, settings,
    run: action => execute('/bin/sh', [join(native, 'phone-boot.sh'), action], {
      env: { ...process.env, EVENTS: events, READY: ready, SETTINGS: settings,
        APP_RUNNING: String(appRunning), FIXTURE_PATH: process.env.PATH }, timeout: 10000,
    }),
    events: () => readFile(events, 'utf8'),
  };
}

test('boot installation writes private startup files without starting existing services', async context => {
  const state = await fixture(context);
  await state.run('install');
  assert.equal((await stat(state.hook)).mode & 0o777, 0o700);
  assert.equal((await stat(state.boot)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(state.boot, 'vpn-before'), 'utf8'), 'null\n');
  assert.equal(await readFile(join(state.settings, 'always_on_vpn_app'), 'utf8'), 'com.tailscale.ipn');
  assert.equal(await readFile(join(state.settings, 'always_on_vpn_lockdown'), 'utf8'), 'null');
  assert.match(await readFile(join(state.boot, 'sshd/run'), 'utf8'), /su -p -g 10166 .* 10166 -c/);
  await state.run('check');
  assert.match(await state.events(), /sshd -t/);
  assert.doesNotMatch(await state.events(), /launch |sv-up /);
});

test('boot installation refuses to overwrite another always-on VPN', async context => {
  const state = await fixture(context, { vpn: 'example.other.vpn' });
  await assert.rejects(state.run('install'));
  await assert.rejects(access(state.hook));
  assert.equal(await readFile(join(state.settings, 'always_on_vpn_app'), 'utf8'), 'example.other.vpn');
});

test('boot installation refuses an existing VPN lockdown policy', async context => {
  const state = await fixture(context, { lockdown: '1' });
  await assert.rejects(state.run('install'));
  await assert.rejects(access(state.hook));
  assert.equal(await readFile(join(state.settings, 'always_on_vpn_lockdown'), 'utf8'), '1');
});

test('boot waits for unlocked storage and keeps the native runtime path when using its copied launcher', async context => {
  const state = await fixture(context);
  await state.run('install');
  await writeFile(state.ready, 'false\n');
  await state.run('run');
  const events = await state.events();
  assert.ok(events.indexOf('wait\n') < events.indexOf('launch '));
  assert.match(events, /runsv .*cctvspoofer\/sshd/);
  assert.ok(events.includes(`sv-up ${state.native}/rootfs/var/lib/cctvspoofer/service`));
  await assert.rejects(access(join(state.root, 'dev/.cctvspoofer-boot-lock')));
});

test('boot does not launch a second SSH daemon when the existing PID is alive', async context => {
  const state = await fixture(context);
  await state.run('install');
  await writeFile(join(state.prefix, 'var/run/sshd.pid'), String(process.pid));
  await mkdir(join(state.root, 'proc', String(process.pid)), { recursive: true });
  await writeFile(join(state.root, 'proc', String(process.pid), 'comm'), 'sshd\n');
  const result = await state.run('run');
  assert.match(result.stdout, /Existing SSH daemon left running/);
  assert.doesNotMatch(await state.events(), /launch /);
});

test('cold boot starts both supervisors using the protected launcher and original runtime directory', async context => {
  const state = await fixture(context, { appRunning: false });
  await state.run('install');
  await state.run('run');
  const events = await state.events();
  assert.match(events, /runsv .*cctvspoofer\/sshd/);
  assert.ok(events.includes(`launch base=${state.native} setsid ${state.root}/system/bin/sh ${state.boot}/phone-native.sh _serve`));
});

test('disabling boot startup restores the previous VPN setting without stopping running services', async context => {
  const state = await fixture(context);
  await state.run('install');
  await state.run('disable');
  await assert.rejects(access(state.hook));
  await assert.rejects(access(join(state.settings, 'always_on_vpn_app')));
  await access(join(state.boot, 'disabled'));
  assert.doesNotMatch(await state.events(), /launch |sv-up /);
});