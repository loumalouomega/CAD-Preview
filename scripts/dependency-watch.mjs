import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const watched = ['opencascade.js', '@loumalouomega/gmsh-wasm', '@meshioplusplus/wasm',
  'float-tetwild-wasm', 'three', '@modelcontextprotocol/sdk'];
const marker = '<!-- cad-preview-dependency-watch -->';
const title = 'Runtime dependency updates available';

export function outdatedRows(result, manifest, root) {
  if (result.error || ![0, 1].includes(result.status)) {
    throw new Error(`npm outdated failed: ${result.error ?? result.stderr}`);
  }
  const data = JSON.parse(result.stdout || '{}');
  if (data.error) throw new Error(`npm outdated failed: ${JSON.stringify(data.error)}`);
  if (result.status === 1 && Object.keys(data).length === 0) throw new Error('npm outdated failed without version data');
  return watched.flatMap(name => {
    const value = data[name];
    const row = Array.isArray(value) ? value.find(row => !root || row.location === join(root, "node_modules", name)) : value;
    if (!row) return [];
    if (!row.current || !row.latest) throw new Error(`Missing installed/latest version for ${name}`);
    return row.current === row.latest ? [] : [{ name, declared: manifest.dependencies[name], current: row.current, latest: row.latest }];
  });
}

export function issueBody(rows) {
  return `${marker}\nThe locked runtime dependencies below trail npm’s latest stable releases. Review compatibility before updating.\n\n` +
    '| Package | Declared | Installed | Latest |\n| --- | --- | --- | --- |\n' +
    rows.map(r => `| ${r.name} | ${r.declared} | ${r.current} | ${r.latest} |`).join('\n') +
    '\n\nValidate kernel loading, metadata, `npm run compat`, `npm run mcp:smoke`, and VSIX packaging after updates.\n';
}

export async function publishReport(rows, api) {
  if (!rows.length) return 'current';
  const body = issueBody(rows);
  const existing = (await api.list()).find(issue => !issue.pull_request && issue.body?.includes(marker));
  if (!existing) { await api.create({ title, body }); return 'created'; }
  if (existing.body === body) return 'unchanged';
  await api.update(existing.number, { title, body });
  return 'updated';
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const result = spawnSync('npm', ['outdated', '--json', ...watched], { cwd: root, encoding: 'utf8', timeout: 120000 });
  const rows = outdatedRows(result, manifest, root);
  console.log(rows.length ? issueBody(rows) : 'All watched runtime dependencies are current.');
  if (!process.argv.includes('--publish')) return;
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repo || !token) throw new Error('Publishing requires GITHUB_REPOSITORY and GH_TOKEN');
  async function request(route, method = 'GET', body) {
    const response = await fetch(`https://api.github.com/repos/${repo}/${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${route}: ${response.status}`);
    return response.json();
  }
  console.log(await publishReport(rows, {
    async list() {
      const all = [];
      for (let page = 1; ; page++) {
        const issues = await request(`issues?state=open&per_page=100&page=${page}`);
        all.push(...issues);
        if (issues.length < 100) return all;
      }
    },
    create: body => request('issues', 'POST', body),
    update: (number, body) => request(`issues/${number}`, 'PATCH', body),
  }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
