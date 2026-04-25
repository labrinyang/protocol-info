import { strict as assert } from 'node:assert';
import { enrichEvidenceDiff } from '../../framework/evidence-diff.mjs';

export const tests = [
  {
    name: 'computes RootData funding discrepancy severity from R1 record',
    fn: async () => {
      const record = { fundingRounds: [{ investors: ['Paradigm'] }] };
      const evidence = {
        rootdata: {
          api_funding: {
            total_funding: '$10000000',
            investors_orgs_normalized: ['paradigm', 'dragonfly', 'variant'],
            investors_people: ['Alice'],
          },
        },
      };
      const out = enrichEvidenceDiff({ evidence, record });
      assert.equal(out.evidence_diff.funding.severity, 'medium');
      assert.deepEqual(out.evidence_diff.funding.missing_org_investors, ['dragonfly', 'variant']);
    },
  },
  {
    name: 'uses none when no comparable funding evidence exists',
    fn: async () => {
      const out = enrichEvidenceDiff({ evidence: {}, record: { fundingRounds: [] } });
      assert.equal(out.evidence_diff.funding.severity, 'none');
    },
  },
];
