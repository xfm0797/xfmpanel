/**
 * 发行版探测：决定包管理器、服务名与仓库地址。
 */

import fs from 'node:fs';
import { runCapture } from './exec.js';

export async function detectDistro() {
  let id = 'unknown';
  let versionId = '';
  let codename = '';
  try {
    const raw = fs.readFileSync('/etc/os-release', 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^(\w+)="?([^"]*)"?$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === 'ID') id = m[2];
      if (m[1] === 'VERSION_ID') versionId = m[2];
      if (m[1] === 'VERSION_CODENAME') codename = m[2];
    }
  } catch { /* 非 Linux 或容器环境 */ }

  const debianFamily = ['ubuntu', 'debian', 'linuxmint', 'raspbian'].includes(id);
  const rhelFamily = ['centos', 'rhel', 'almalinux', 'rocky', 'fedora', 'openeuler'].includes(id);

  return {
    id,
    versionId,
    codename,
    family: debianFamily ? 'debian' : rhelFamily ? 'rhel' : 'unknown',
    pkg: debianFamily ? 'apt' : rhelFamily ? 'dnf' : null,
  };
}

export async function isInstalled(pkg) {
  const res = await runCapture('dpkg', ['-s', pkg], { timeout: 10_000 });
  return res.ok;
}

export async function aptInstall(packages, emit, { timeout = 900_000 } = {}) {
  return aptRun(['install', '-y', '--no-install-recommends', ...packages], emit, { timeout });
}

export async function aptRemove(packages, emit) {
  return aptRun(['purge', '-y', ...packages], emit);
}

async function aptRun(args, emit, { timeout = 900_000 } = {}) {
  const { run } = await import('./exec.js');
  let count = 0;
  return run('apt-get', ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', ...args], {
    timeout,
    env: { DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C' },
    onLine: (line) => {
      if (count > 400) return;
      if (!/^(Setting up|Unpacking|Get:|Err:|E:|W:|Fetched|Selecting|Preparing|Processing triggers|update-alternatives)/.test(line)) return;
      count += 1;
      emit.log(/^(Err:|E:)/.test(line) ? 'warn' : 'info', line.slice(0, 300));
    },
  });
}

export async function aptUpdate(emit) {
  const { run } = await import('./exec.js');
  let count = 0;
  return run('apt-get', ['update', '-y'], {
    timeout: 300_000,
    env: { LC_ALL: 'C' },
    onLine: (line) => {
      if (count > 60) return;
      if (!/^(Hit|Get|Ign|Err|E:)/.test(line)) return;
      count += 1;
      if (/^(Err|E:)/.test(line)) emit.log('warn', line.slice(0, 300));
    },
  });
}

/** Ubuntu 用 ondrej PPA，Debian 用 sury 源，以获得多版本 PHP */
export async function ensurePhpRepo(version, distro, emit) {
  const candidate = await runCapture('apt-cache', ['policy', `php${version}-fpm`], { timeout: 20_000 });
  const hasCandidate = candidate.ok && /Candidate:\s*\d/.test(candidate.stdout);
  if (hasCandidate) return { added: false };

  emit.log('info', '当前软件源不包含该 PHP 版本，正在添加第三方 PHP 源');
  await aptInstall(['ca-certificates', 'curl', 'gnupg', 'lsb-release', 'apt-transport-https'], emit);

  if (distro.id === 'ubuntu') {
    await aptInstall(['software-properties-common'], emit);
    const { run } = await import('./exec.js');
    await run('add-apt-repository', ['-y', 'ppa:ondrej/php'], {
      timeout: 300_000,
      env: { LC_ALL: 'C', DEBIAN_FRONTEND: 'noninteractive' },
      onLine: (line) => {
        if (/^(gpg|Get|Hit|Err|E:)/.test(line)) emit.log('info', line.slice(0, 200));
      },
    });
  } else {
    const keyPath = '/usr/share/keyrings/sury-php.gpg';
    const { run } = await import('./exec.js');
    await run('curl', ['-fsSL', 'https://packages.sury.org/php/apt.gpg', '-o', keyPath], { timeout: 60_000 });
    const listPath = '/etc/apt/sources.list.d/sury-php.list';
    const fs = await import('node:fs');
    fs.writeFileSync(
      listPath,
      `deb [signed-by=${keyPath}] https://packages.sury.org/php/ ${distro.codename || 'bookworm'} main\n`,
    );
    emit.log('info', `已写入 PHP 源：${listPath}`);
  }

  await aptUpdate(emit);
  return { added: true };
}
