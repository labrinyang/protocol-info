import { strict as assert } from 'node:assert';
import { mergeSlices } from '../../framework/merger.mjs';

export const tests = [
  {
    name: 'merges 4 disjoint slices',
    fn: async () => {
      const result = mergeSlices([
        { name: 'metadata', ok: true, slice: { slug: 's', displayName: 'S', type: 'staking' } },
        { name: 'team', ok: true, slice: { members: [{memberName: 'A'}] } },
        { name: 'funding', ok: true, slice: { fundingRounds: [{round: 'Seed'}] } },
        { name: 'audits', ok: true, slice: { audits: { items: [], lastScannedAt: '2026-01-01' } } },
      ]);
      assert.equal(result.record.slug, 's');
      assert.equal(result.record.members.length, 1);
      assert.equal(result.record.fundingRounds.length, 1);
      assert.equal(result.record.audits.lastScannedAt, '2026-01-01');
      assert.deepEqual(result.failed_subtasks, []);
    },
  },
  {
    name: 'records failed subtask + falls back to {} for its slice',
    fn: async () => {
      const result = mergeSlices([
        { name: 'metadata', ok: true, slice: { slug: 's' } },
        { name: 'team', ok: false, error: 'boom' },
      ]);
      assert.equal(result.record.slug, 's');
      assert.equal('members' in result.record, false);
      assert.deepEqual(result.failed_subtasks, [{ name: 'team', reason: 'boom' }]);
    },
  },
  {
    name: 'collides on overlapping field — last writer wins, but warns',
    fn: async () => {
      let warned = false;
      const result = mergeSlices([
        { name: 'a', ok: true, slice: { x: 1 } },
        { name: 'b', ok: true, slice: { x: 2 } },
      ], { onCollision: () => { warned = true; } });
      assert.equal(result.record.x, 2);
      assert.equal(warned, true);
    },
  },
];
