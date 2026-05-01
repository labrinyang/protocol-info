import { strict as assert } from 'node:assert';
import { runNormalizers } from '../../framework/normalizer-stage.mjs';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeNormalizerModule(body) {
  const dir = await mkdtemp(join(tmpdir(), 'norm-test-'));
  const path = join(dir, 'norm.mjs');
  await writeFile(path, body, 'utf8');
  return path;
}

export const tests = [
  {
    name: 'returns record unchanged when no normalizers configured',
    fn: async () => {
      const out = await runNormalizers({ normalizers: [], record: { x: 1 } });
      assert.deepEqual(out.record, { x: 1 });
      assert.deepEqual(out.changes, []);
      assert.deepEqual(out.gaps, []);
    },
  },
  {
    name: 'applies single normalizer and threads record + changes',
    fn: async () => {
      const path = await makeNormalizerModule(
        `export default ({record}) => ({record:{...record, normalized:true}, changes:[{field:'x', before:null, after:1, reason:'t', source:'f', confidence:1}], gaps:[]})`
      );
      const out = await runNormalizers({
        normalizers: [{ name: 'test-norm', module_abs: path }],
        record: { x: 1 },
      });
      assert.equal(out.record.normalized, true);
      assert.equal(out.changes.length, 1);
      assert.equal(out.changes[0].stage, 'normalize');
      assert.equal(out.changes[0].normalizer, 'test-norm');
    },
  },
  {
    name: 'appends to incoming changes/gaps without dropping them',
    fn: async () => {
      const path = await makeNormalizerModule(
        `export default ({record}) => ({record, changes:[{field:'b', before:0, after:1, reason:'r', source:'s', confidence:1}], gaps:[{field:'g', reason:'r'}]})`
      );
      const out = await runNormalizers({
        normalizers: [{ name: 'test', module_abs: path }],
        record: { x: 1 },
        incomingChanges: [{ field: 'a', before: null, after: 'X', reason: 'r2', source: 'r2', confidence: 0.9 }],
        incomingGaps: [{ field: 'pre-existing', reason: 'old' }],
      });
      assert.equal(out.changes.length, 2);
      assert.equal(out.changes[0].field, 'a');
      assert.equal(out.changes[1].field, 'b');
      assert.equal(out.changes[1].normalizer, 'test');
      assert.equal(out.gaps.length, 2);
    },
  },
  {
    name: 'drops stale incoming gaps when a normalizer resolves the same field',
    fn: async () => {
      const path = await makeNormalizerModule(
        `export default ({record}) => ({record, changes:[{field:'providerLogoUrl', before:null, after:'https://cdn.example/logo.png', reason:'r', source:'s', confidence:1}], gaps:[]})`
      );
      const out = await runNormalizers({
        normalizers: [{ name: 'test', module_abs: path }],
        record: {},
        incomingGaps: [
          { field: 'providerLogoUrl', reason: 'old missing logo' },
          { field: 'members[0].avatarUrl', reason: 'still missing' },
        ],
      });
      assert.deepEqual(out.gaps, [{ field: 'members[0].avatarUrl', reason: 'still missing' }]);
    },
  },
  {
    name: 'drops stale gaps when the current record already has a concrete value',
    fn: async () => {
      const path = await makeNormalizerModule(
        `export default ({record}) => ({record, changes:[], gaps:[]})`
      );
      const out = await runNormalizers({
        normalizers: [{ name: 'test', module_abs: path }],
        record: {
          providerLogoUrl: 'https://cdn.example/provider.png',
          members: [{ memberName: 'TN Lee', avatarUrl: 'https://cdn.example/tn.png' }],
        },
        incomingGaps: [
          { field: 'providerLogoUrl', reason: 'old missing logo' },
          { field: 'members[0].avatarUrl', entity_key: 'member:TN Lee', reason: 'old missing avatar' },
          { field: 'members[0].oneLiner', entity_key: 'member:TN Lee', reason: 'still missing' },
        ],
      });
      assert.deepEqual(out.gaps, [
        { field: 'members[0].oneLiner', entity_key: 'member:TN Lee', reason: 'still missing' },
      ]);
    },
  },
  {
    name: 'drops stale wildcard gaps only when all matching concrete fields are resolved',
    fn: async () => {
      const path = await makeNormalizerModule(
        `export default ({record}) => ({record:{members:[{avatarUrl:'https://cdn.example/a.png'},{avatarUrl:'https://cdn.example/b.png'}],audits:{items:[{auditorLogoUrl:'https://cdn.example/o.png'},{auditorLogoUrl:null}]}}, changes:[{field:'members[0].avatarUrl', before:null, after:'https://cdn.example/a.png', reason:'r', source:'s', confidence:1},{field:'audits.items[0].auditorLogoUrl', before:null, after:'https://cdn.example/o.png', reason:'r', source:'s', confidence:1}], gaps:[]})`
      );
      const out = await runNormalizers({
        normalizers: [{ name: 'test', module_abs: path }],
        record: {},
        incomingGaps: [
          { field: 'members[].avatarUrl', reason: 'old member avatars missing' },
          { field: 'members[*].avatarUrl', reason: 'old member avatars missing' },
          { field: 'audits.items[*].auditorLogoUrl', reason: 'old audit logos missing' },
        ],
      });
      assert.deepEqual(out.gaps, [
        { field: 'audits.items[*].auditorLogoUrl', reason: 'old audit logos missing' },
      ]);
    },
  },
  {
    name: 'keeps gaps when a normalizer changes a field to null',
    fn: async () => {
      const path = await makeNormalizerModule(
        `export default ({record}) => ({record, changes:[{field:'members[0].oneLiner', before:'placeholder', after:null, reason:'r', source:'s', confidence:1}], gaps:[{field:'members[0].oneLiner', reason:'now explicitly missing'}]})`
      );
      const out = await runNormalizers({
        normalizers: [{ name: 'test', module_abs: path }],
        record: {},
        incomingGaps: [{ field: 'members[0].oneLiner', reason: 'old placeholder' }],
      });
      assert.equal(out.gaps.length, 2);
    },
  },
  {
    name: 'passes extra context through to normalizers',
    fn: async () => {
      const path = await makeNormalizerModule(
        `export default ({record, outputRoot, slugDir}) => ({record:{...record, outputRoot, slugDir}, changes:[], gaps:[]})`
      );
      const out = await runNormalizers({
        normalizers: [{ name: 'ctx', module_abs: path }],
        record: {},
        outputRoot: '/tmp/out',
        slugDir: '/tmp/out/pendle',
      });
      assert.equal(out.record.outputRoot, '/tmp/out');
      assert.equal(out.record.slugDir, '/tmp/out/pendle');
    },
  },
];
