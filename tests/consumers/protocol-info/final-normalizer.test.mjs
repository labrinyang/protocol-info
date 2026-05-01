import { strict as assert } from 'node:assert';
import normalize from '../../../consumers/protocol-info/normalizers/final.mjs';

function baseRecord(oneLiner) {
  return {
    slug: 'pendle',
    provider: 'pendle',
    displayName: 'Pendle',
    members: [
      {
        memberName: 'Alice Liu',
        memberPosition: 'Co-Founder',
        oneLiner,
        avatarUrl: null,
        memberLink: { xLink: null, linkedinLink: null },
      },
    ],
    audits: { items: [], lastScannedAt: '1970-01-01' },
  };
}

export const tests = [
  {
    name: 'placeholder member oneLiner is set to null',
    fn: () => {
      const out = normalize({
        record: baseRecord('暂未提供。 在此处添加占位说明以确保字符串非空。'),
        now: new Date('2026-04-29T00:00:00Z'),
      });

      assert.equal(out.record.members[0].oneLiner, null);
      assert.equal(out.changes[0].field, 'members[0].oneLiner');
      assert.equal(out.changes[0].reason, 'placeholder_one_liner_removed');
      assert.equal(out.gaps[0].field, 'members[0].oneLiner');
    },
  },
  {
    name: 'verifiable member oneLiner is preserved',
    fn: () => {
      const oneLiner = 'Former research lead at Paradigm.';
      const out = normalize({
        record: baseRecord(oneLiner),
        now: new Date('2026-04-29T00:00:00Z'),
      });

      assert.equal(out.record.members[0].oneLiner, oneLiner);
      assert.equal(out.changes.some((change) => change.field === 'members[0].oneLiner'), false);
      assert.equal(out.gaps.length, 0);
    },
  },
  {
    name: 'short role-only oneLiners are treated as placeholders',
    fn: () => {
      for (const oneLiner of ['team member', 'Founder', 'CTO']) {
        const out = normalize({
          record: baseRecord(oneLiner),
          now: new Date('2026-04-29T00:00:00Z'),
        });
        assert.equal(out.record.members[0].oneLiner, null, oneLiner);
      }
    },
  },
  {
    name: 'audit scan date is still normalized after oneLiner cleanup',
    fn: () => {
      const out = normalize({
        record: {
          ...baseRecord('Unverified'),
          audits: { items: [{ auditor: 'OpenZeppelin', auditorLogoUrl: null }], lastScannedAt: '1970-01-01' },
        },
        now: new Date('2026-04-29T12:00:00Z'),
      });

      assert.equal(out.record.members[0].oneLiner, null);
      assert.equal(out.record.audits.lastScannedAt, '2026-04-29');
      assert.equal(out.changes.some((change) => change.field === 'audits.lastScannedAt'), true);
    },
  },
];
