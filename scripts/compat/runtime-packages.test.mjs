import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nodeCjsBase, WASM_EXTERNALS } from '../nodeBundleConfig.mjs';
import { runtimePackages } from '../runtimeAssets.mjs';

const root = mkdtempSync(join(tmpdir(), 'cad runtime #'));
let bundle;
beforeAll(async () => {
  bundle = await build(nodeCjsBase({
    stdin: { contents: `export { getMeshio, resetMeshio, readMeshioMetadata } from './src/meshioService'; export { getFtetwild, tetrahedralize } from './src/ftetwildService';`, resolveDir: process.cwd() },
    // Match an embedding consumer with no aliases or external declarations
    // for these two packages: literal imports would inline ESM/top-level await.
    external: WASM_EXTERNALS.filter(name => !['@meshioplusplus/wasm', 'float-tetwild-wasm'].includes(name)),
    write: false,
  }));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
function setup(name, nested = false) {
  const base = join(root, name);
  const dir = nested ? join(base, 'cad-runtime', 'dist') : base;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bundle.cjs'), bundle.outputFiles[0].contents);
  return { base, dir };
}
function run(dir, code) {
  writeFileSync(join(dir, 'run.cjs'), `const assert = require('node:assert/strict'); const api = require('./bundle.cjs'); (async () => { ${code} })().catch(e => { console.error(e); process.exitCode = 1; });`);
  return spawnSync(process.execPath, [join(dir, 'run.cjs')], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_PATH: '' } });
}
function fake(base, kind, code) {
  const dir = kind === 'installed' ? join(base, 'node_modules', '@meshioplusplus', 'wasm') : join(base, 'meshio');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@meshioplusplus/wasm', type: 'module', main: './src/index.mjs' }));
  writeFileSync(join(dir, 'src/index.mjs'), code);
}
function success(result) {
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
}
describe('CJS runtime package loading without loader aliases', () => {
  it('prefers installed packages and memoizes initialization', () => {
    const { base, dir } = setup('precedence');
    fake(base, 'installed', `await Promise.resolve(); export async function loadMeshioPlusPlus(_, options) { if(options.variant !== 'seq') throw Error('threads'); return { source: 'installed' }; }`);
    fake(base, 'staged', `throw Error('must not import fallback');`);
    success(run(dir, `const a = api.getMeshio(); assert.equal(a, api.getMeshio()); assert.equal((await a).source, 'installed');`));
  });
  it('does not hide initialization errors and retries rejected initialization', () => {
    const { base, dir } = setup('retry');
    fake(base, 'installed', `let tries = 0; export async function loadMeshioPlusPlus() { if (++tries === 1) throw Error('init failed'); return { tries }; }`);
    fake(base, 'staged', `throw Error('must not import fallback');`);
    success(run(dir, `await assert.rejects(api.getMeshio(), /init failed/); assert.equal((await api.getMeshio()).tries, 2);`));
  });
  it('does not hide an installed package import error', () => {
    const { base, dir } = setup('broken-import');
    fake(base, 'installed', `throw Error('broken selected package');`);
    fake(base, 'staged', `export async function loadMeshioPlusPlus() { return {}; }`);
    success(run(dir, `await assert.rejects(api.getMeshio(), /broken selected package/);`));
  });
  it('reports missing runtime assets', () => {
    const { dir } = setup('missing');
    success(run(dir, `await assert.rejects(api.getMeshio(), /was not found.*meshio/); await assert.rejects(api.getFtetwild(), /was not found.*ftetwild/);`));
  });
  for (const nested of [false, true]) it(`loads real WASM from ${nested ? 'nested KKSS' : 'adjacent'} staged trees`, () => {
    const { base, dir } = setup(`live-${nested}`, nested);
    for (const pkg of runtimePackages) {
      for (const file of pkg.files) {
        const target = join(base, pkg.directory, file);
        mkdirSync(resolve(target, '..'), { recursive: true });
        cpSync(join('node_modules', pkg.name, file), target);
      }
    }
    cpSync('examples/MED/two-material-tets.med', join(dir, 'input.med'));
    success(run(dir, `
      const m = await api.getMeshio(); assert.equal(m.parallelBackend(), 'seq');
      const bytes = require('node:fs').readFileSync(require('node:path').join(__dirname, 'input.med'));
      m.FS.writeFile('/input.med', bytes);
      const mesh = m.readMesh('/input.med', 'med');
      assert.equal(mesh.regions.length, 2);
      assert.ok(mesh.cell_data.cell_tags[0] instanceof BigInt64Array);
      const boundary = m.extractSurface({ ...mesh, regions: [] }, true);
      assert.ok(boundary.cell_data['surface:parent_cell'][0] instanceof BigInt64Array);
      assert.deepEqual((await api.readMeshioMetadata(bytes, 'med')).regions.map(r => r.name).sort(), ['MaterialA', 'MaterialB']);
      for (const format of ['med', 'cgns', 'gid']) {
        const file = format === 'gid' ? '/metadata.post.msh' : '/metadata.' + format;
        const files = m.writeMesh(file, mesh, format);
        const full = m.readMesh(file, format);
        const companions = files.filter(p => p !== file).map(p => ({ name: p.split('/').pop(), bytes: m.FS.readFile(p) }));
        const summary = await api.readMeshioMetadata(m.FS.readFile(file), format, file.split('/').pop(), companions);
        assert.deepEqual(summary.pointDataNames.sort(), Object.keys(full.point_data).sort());
        assert.deepEqual(summary.cellDataNames.sort(), Object.keys(full.cell_data).sort());
        assert.ok(summary.cellDataNames.includes('cell_tags'));
      }
      m.FS.writeFile('/input.off', 'OFF\\n4 4 0\\n0 0 0\\n1 0 0\\n0 1 0\\n0 0 1\\n3 0 2 1\\n3 0 1 3\\n3 0 3 2\\n3 1 2 3\\n');
      m.convert('/input.off', '/output.stl', { inFormat: 'off', outFormat: 'stl' });
      assert.ok(m.FS.readFile('/output.stl').length > 84);
      const result = await api.tetrahedralize({ positions: new Float32Array([0,0,0,1,0,0,0,1,0,0,0,1]), indices: new Uint32Array([0,2,1,0,1,3,0,3,2,1,2,3]) }, { idealEdgeLengthRel: 0.5, maxIts: 2 });
      assert.ok(result.tets.length > 0); assert.ok(result.vertices.length > 0);
    `));
  }, 90000);
});
