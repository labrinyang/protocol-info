import { strict as assert } from 'node:assert';
import { mergeSlices, mergeR2 } from '../../framework/merger.mjs';

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
  {
    name: 'accumulates findings and gaps with stage + subtask tags',
    fn: async () => {
      const result = mergeSlices([
        { name: 'metadata', ok: true, slice: { slug: 's' },
          findings: [{ field: 'slug', value: 's', source: 'https://x', confidence: 1 }],
          gaps: [],
          handoff_notes: [] },
        { name: 'team', ok: true, slice: { members: [] },
          findings: [],
          gaps: [{ field: 'members', reason: 'no team page found', tried: ['website'] }],
          handoff_notes: [{ target: 'funding', note: 'A appears in seed announcement', source: 'https://example.com/seed' }] },
      ], { stage: 'r1' });
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].subtask, 'metadata');
      assert.equal(result.findings[0].stage, 'r1');
      assert.equal(result.gaps.length, 1);
      assert.equal(result.gaps[0].subtask, 'team');
      assert.equal(result.gaps[0].stage, 'r1');
      assert.equal(result.handoff_notes.length, 1);
      assert.equal(result.handoff_notes[0].subtask, 'team');
      assert.equal(result.handoff_notes[0].stage, 'r1');
    },
  },
  {
    name: 'mergeR2 accepts new R2 value when R1 had no finding for the field',
    fn: async () => {
      const r1 = {
        record: { description: 'old', tags: [] },
        findings: [{ field: 'description', value: 'old', source: 'https://x', confidence: 0.9 }],
        gaps: [],
      };
      const r2 = {
        record: { description: 'old', tags: ['yield'] },
        findings: [{ field: 'tags', value: ['yield'], source: 'https://y', confidence: 0.95 }],
        changes: [{ field: 'tags', before: [], after: ['yield'], reason: 'DeFiLlama category confirms yield', source: 'https://defillama.com', confidence: 0.95 }],
        gaps: [],
      };
      const m = mergeR2(r1, r2);
      assert.deepEqual(m.record.tags, ['yield']);
    },
  },
  {
    name: 'mergeR2 rejects uncited R2 change to a high-confidence R1 field',
    fn: async () => {
      const r1 = {
        record: { description: 'GOOD' },
        findings: [{ field: 'description', value: 'GOOD', source: 'https://x', confidence: 0.92 }],
        gaps: [],
      };
      const r2 = {
        record: { description: 'WEAKER' },
        findings: [],
        changes: [],
        gaps: [],
      };
      const m = mergeR2(r1, r2);
      assert.equal(m.record.description, 'GOOD');
      assert.ok(m.gaps.some(g => g.reason && g.reason.includes('r2_uncited_high_conf_change_suppressed')));
    },
  },
  {
    name: 'mergeR2 accepts R2 when R2 has higher confidence than R1',
    fn: async () => {
      const r1 = {
        record: { description: 'guess' },
        findings: [{ field: 'description', value: 'guess', source: 'https://x', confidence: 0.5 }],
        gaps: [],
      };
      const r2 = {
        record: { description: 'verified' },
        findings: [{ field: 'description', value: 'verified', source: 'https://y', confidence: 0.95 }],
        changes: [{ field: 'description', before: 'guess', after: 'verified', reason: 'official docs wording', source: 'https://y', confidence: 0.95 }],
        gaps: [],
      };
      const m = mergeR2(r1, r2);
      assert.equal(m.record.description, 'verified');
    },
  },
  {
    name: 'mergeR2 treats array descendant/entity_key evidence as explanation',
    fn: async () => {
      const r1 = {
        record: { members: [{ memberName: 'A', oneLiner: 'old', memberLink: { xLink: 'https://x.com/a' } }] },
        findings: [{ field: 'members', value: [], source: 'https://x', confidence: 0.92 }],
        gaps: [],
      };
      const r2 = {
        record: { members: [{ memberName: 'A', oneLiner: 'new', memberLink: { xLink: 'https://x.com/a' } }] },
        findings: [{ field: 'members[0].oneLiner', entity_key: 'member:x:https://x.com/a', value: 'new', source: 'https://y', confidence: 0.95 }],
        changes: [{ field: 'members[0].oneLiner', entity_key: 'member:x:https://x.com/a', before: 'old', after: 'new', reason: 'profile updated', source: 'https://y', confidence: 0.95 }],
        gaps: [],
      };
      const m = mergeR2(r1, r2);
      assert.equal(m.record.members[0].oneLiner, 'new');
      assert.equal(m.gaps.some(g => g.reason === 'uncited_r2_change'), false);
    },
  },
  {
    name: 'mergeR2 keeps higher-confidence R1 finding when R2 re-emits same field at lower confidence',
    fn: async () => {
      const r1 = {
        record: { description: 'X' },
        findings: [{ field: 'description', value: 'X', source: 'https://r1', confidence: 0.92 }],
        gaps: [],
      };
      const r2 = {
        record: { description: 'X' },
        findings: [{ field: 'description', value: 'X', source: 'https://r2', confidence: 0.5 }],
        changes: [],
        gaps: [],
      };
      const m = mergeR2(r1, r2);
      const dF = m.findings.filter(f => f.field === 'description');
      assert.equal(dF.length, 1);
      assert.equal(dF[0].confidence, 0.92);
      assert.equal(dF[0].source, 'https://r1');
    },
  },
  {
    name: 'mergeR2 emits r2_added_field_uncited gap for R2-only leaf field with no provenance',
    fn: async () => {
      const r1 = {
        record: { description: 'X' },
        findings: [{ field: 'description', value: 'X', source: 'https://x', confidence: 0.9 }],
        gaps: [],
      };
      const r2 = {
        record: { description: 'X', tokenSymbol: 'FOO' },
        findings: [],
        changes: [],
        gaps: [],
      };
      const m = mergeR2(r1, r2);
      assert.equal(m.record.tokenSymbol, 'FOO');
      assert.ok(m.gaps.some(g => g.field === 'tokenSymbol' && g.reason === 'r2_added_field_uncited'));
    },
  },
  {
    name: 'mergeR2 accepts array additions when R2 cites the new item via entity_key',
    fn: async () => {
      const r1 = {
        record: { members: [{ memberName: 'A', memberLink: { xLink: 'https://x.com/a' } }] },
        findings: [{ field: 'members', value: [], source: 'https://x', confidence: 0.92 }],
        gaps: [],
      };
      const r2 = {
        record: {
          members: [
            { memberName: 'A', memberLink: { xLink: 'https://x.com/a' } },
            { memberName: 'B', memberLink: { xLink: 'https://x.com/b' } },
          ],
        },
        findings: [{ field: 'members[1]', entity_key: 'member:x:https://x.com/b', value: { memberName: 'B' }, source: 'https://blog.example.com/b-joins', confidence: 0.9 }],
        changes: [{ field: 'members[1]', entity_key: 'member:x:https://x.com/b', before: null, after: { memberName: 'B' }, reason: 'announcement', source: 'https://blog.example.com/b-joins', confidence: 0.9 }],
        gaps: [],
      };
      const m = mergeR2(r1, r2);
      assert.equal(m.record.members.length, 2);
      assert.equal(m.gaps.some(g => g.reason && g.reason.includes('r2_uncited_high_conf_change_suppressed')), false);
    },
  },
];
