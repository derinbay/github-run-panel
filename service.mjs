#!/usr/bin/env node
// Runs the panel in the background at login, with no terminal window.
//   node service.mjs install | uninstall | start | stop | status
// Windows: a hidden launcher in the Startup folder. macOS: a LaunchAgent. Linux: a systemd user unit.
// None of these need administrator rights.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { appDir, loadConfig, logFile, pidFile, stateDir } from './config.mjs';

const NAME = 'github-run-panel';
const LABEL = 'io.github.github-run-panel';
const node = process.execPath;
const server = path.join(appDir, 'server.mjs');
const home = os.homedir();
const platform = process.platform;
const { port } = await loadConfig();
const url = `http://localhost:${port}`;
const PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.dirname(node)].join(':');

const files = {
  win32: path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${NAME}.vbs`),
  darwin: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
  linux: path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', `${NAME}.service`),
};
const registration = files[platform];
if (!registration) {
  console.error(`Background mode is not supported on ${platform}. Run "npm start" instead.`);
  process.exit(1);
}

const run = (cmd, args, quiet = false) => {
  try {
    return execFileSync(cmd, args, { stdio: quiet ? 'ignore' : 'inherit', windowsHide: true });
  } catch (e) {
    if (!quiet) throw e;
    return null;
  }
};
const xml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const vbs = (s) => s.replaceAll('"', '""');
const uid = () => process.getuid();

function registrationText() {
  if (platform === 'win32') {
    // Window style 0 starts node with no console window.
    return [
      'Set shell = CreateObject("WScript.Shell")',
      `shell.CurrentDirectory = "${vbs(appDir)}"`,
      `shell.Run """${vbs(node)}"" ""${vbs(server)}"" --service", 0, False`,
      '',
    ].join('\r\n');
  }
  if (platform === 'darwin') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(server)}</string>
    <string>--service</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(appDir)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(PATH)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardErrorPath</key><string>${xml(path.join(stateDir(), 'launchd.err'))}</string>
</dict>
</plist>
`;
  }
  return `[Unit]
Description=GitHub Run Panel
After=network-online.target

[Service]
ExecStart="${node}" "${server}" --service
WorkingDirectory=${appDir}
Environment=PATH=${PATH}
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

function readPid() {
  try {
    const pid = Number(readFileSync(pidFile(), 'utf8').trim());
    if (!pid) return null;
    process.kill(pid, 0); // throws when no such process
    return pid;
  } catch {
    return null;
  }
}

function answers(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: `localhost:${port}` }, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitFor(want, seconds = 15) {
  for (let i = 0; i < seconds * 4; i++) {
    if ((await answers(500)) === want) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function openBrowser() {
  const [cmd, args] = platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
}

async function start({ open = true } = {}) {
  if (await answers()) {
    console.log(`Already running: ${url}`);
    return;
  }
  mkdirSync(stateDir(), { recursive: true });
  if (platform === 'win32') {
    spawn(node, [server, '--service'], { cwd: appDir, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (platform === 'darwin') {
    if (!existsSync(registration)) throw new Error('Not installed. Run "npm run install-service" first.');
    // bootstrap fails when the agent is already loaded; kickstart then starts it.
    if (!run('launchctl', ['bootstrap', `gui/${uid()}`, registration], true)) run('launchctl', ['kickstart', `gui/${uid()}/${LABEL}`]);
  } else {
    run('systemctl', ['--user', 'start', `${NAME}.service`]);
  }
  if (!(await waitFor(true))) {
    console.error(`The panel did not start. See the log: ${logFile()}`);
    process.exit(1);
  }
  console.log(`Running in the background: ${url}`);
  if (open) openBrowser();
}

async function stop() {
  if (platform === 'linux') {
    run('systemctl', ['--user', 'stop', `${NAME}.service`], true);
  } else {
    const pid = readPid();
    if (pid) {
      // SIGTERM makes the server exit with code 0, so launchd's KeepAlive does not restart it.
      process.kill(pid, 'SIGTERM');
      // On Windows the process is killed without running its exit handler; clean up its PID file here.
      if (platform === 'win32') rmSync(pidFile(), { force: true });
    }
  }
  const stopped = await waitFor(false, 10);
  console.log(stopped ? 'Stopped.' : `Port ${port} still answers: another copy (for example "npm start" in a terminal) is running.`);
}

async function install() {
  mkdirSync(path.dirname(registration), { recursive: true });
  mkdirSync(stateDir(), { recursive: true });
  if (platform === 'darwin') run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], true); // reload a changed plist
  writeFileSync(registration, registrationText());
  if (platform === 'linux') {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', `${NAME}.service`]);
  }
  console.log(`Starts at login: ${registration}`);
  await start();
}

async function uninstall() {
  if (platform === 'darwin') run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], true);
  if (platform === 'linux') run('systemctl', ['--user', 'disable', `${NAME}.service`], true);
  await stop();
  rmSync(registration, { force: true });
  if (platform === 'linux') run('systemctl', ['--user', 'daemon-reload'], true);
  console.log('Removed from login items.');
}

async function status() {
  const pid = readPid();
  console.log(`Login item: ${existsSync(registration) ? registration : 'not installed'}`);
  console.log(`Server:     ${(await answers()) ? `answering at ${url}` : 'not answering'}${pid ? ` (pid ${pid})` : ''}`);
  console.log(`Log:        ${logFile()}`);
}

const commands = { install, uninstall, start, stop, status };
const cmd = process.argv[2];
if (!commands[cmd]) {
  console.error('Usage: node service.mjs install | uninstall | start | stop | status');
  process.exit(1);
}
await commands[cmd]();
