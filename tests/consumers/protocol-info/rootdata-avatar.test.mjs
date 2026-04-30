import { strict as assert } from 'node:assert';
import normalize from '../../../consumers/protocol-info/normalizers/rootdata-avatar.mjs';

function baseRecord(members) {
  return { members };
}

function evidenceWith(candidates, status = 'ok') {
  return {
    fetcher_status: { rootdata: status },
    rootdata: { member_candidates: candidates },
  };
}

export const tests = [
  {
    name: 'exact RootData candidate match wins before Unavatar',
    fn: async () => {
      const record = baseRecord([
        { memberName: 'Robert Leshner', avatarUrl: null, memberLink: { xLink: 'https://x.com/rleshner', linkedinLink: null } },
      ]);
      const evidence = evidenceWith([
        { name: 'Robert Leshner', avatar_url: 'https://cdn.rootdata.com/people/robert.png', bucket: 'likely_member' },
      ]);
      const out = await normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, 'https://cdn.rootdata.com/people/robert.png');
      assert.equal(out.changes.length, 1);
      assert.equal(out.changes[0].field, 'members[0].avatarUrl');
      assert.equal(out.changes[0].source, 'rootdata.member_candidates');
      assert.equal(out.changes[0].before, null);
      assert.equal(out.changes[0].after, 'https://cdn.rootdata.com/people/robert.png');
      assert.equal(out.gaps.length, 0);
    },
  },
  {
    name: 'RootData name match is case- and whitespace-insensitive',
    fn: async () => {
      const record = baseRecord([{ memberName: '  vitalik   buterin ', avatarUrl: null }]);
      const evidence = evidenceWith([
        { name: 'Vitalik Buterin', avatar_url: 'https://cdn.rootdata.com/v.png' },
      ]);
      const out = await normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, 'https://cdn.rootdata.com/v.png');
      assert.equal(out.gaps.length, 0);
    },
  },
  {
    name: 'project candidate miss → direct RootData person search fills avatar',
    fn: async () => {
      const record = {
        slug: 'pendle',
        provider: 'pendle',
        displayName: 'Pendle',
        members: [{ memberName: 'TN Lee', avatarUrl: null, memberLink: { xLink: null, linkedinLink: null } }],
      };
      const searchCalls = [];
      const searchRootData = async (args) => {
        searchCalls.push(args);
        return {
          ok: true,
          results: [
            {
              name: 'TN Lee',
              introduce: 'TN Lee is currently the Director at Pendle.',
              logo: 'https://public.rootdata.com/images/b39/1712906040035.jpg',
            },
          ],
        };
      };
      const out = await normalize({
        record,
        evidence: evidenceWith([{ name: 'Someone Else', avatar_url: 'https://cdn.rootdata.com/x.png' }]),
        env: { ROOTDATA_API_KEY: 'test-key' },
        searchRootData,
      });
      assert.equal(out.record.members[0].avatarUrl, 'https://public.rootdata.com/images/b39/1712906040035.jpg');
      assert.equal(searchCalls.length, 1);
      assert.equal(searchCalls[0].query, 'TN Lee');
      assert.equal(searchCalls[0].type, 'person');
      assert.equal(out.changes[0].source, 'rootdata.people_search');
    },
  },
  {
    name: 'RootData source overwrites existing Unavatar source before rehost',
    fn: async () => {
      const record = baseRecord([
        { memberName: 'Alice Liu', avatarUrl: 'https://unavatar.io/x/aliceliu?fallback=false' },
      ]);
      const evidence = evidenceWith([
        { name: 'Alice Liu', avatar_url: 'https://cdn.rootdata.com/alice.png' },
      ]);
      const out = await normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, 'https://cdn.rootdata.com/alice.png');
      assert.equal(out.changes[0].before, 'https://unavatar.io/x/aliceliu?fallback=false');
      assert.equal(out.changes[0].after, 'https://cdn.rootdata.com/alice.png');
    },
  },
  {
    name: 'no candidate match with X link → paid Unavatar source URL is used',
    fn: async () => {
      const record = baseRecord([
        { memberName: '0xngmi', avatarUrl: null, memberLink: { xLink: 'https://x.com/0xngmi', linkedinLink: null } },
      ]);
      const evidence = evidenceWith([
        { name: 'Someone Else', avatar_url: 'https://cdn.rootdata.com/x.png' },
      ]);
      const out = await normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, 'https://unavatar.io/x/0xngmi?fallback=false');
      assert.equal(out.gaps.length, 0);
      assert.equal(out.changes[0].after, 'https://unavatar.io/x/0xngmi?fallback=false');
      assert.equal(out.changes[0].reason, 'unavatar_x_avatar_fallback');
      assert.equal(out.changes[0].source, 'unavatar:x');
    },
  },
  {
    name: 'direct RootData person search must mention the protocol before use',
    fn: async () => {
      const record = {
        slug: 'pendle',
        provider: 'pendle',
        displayName: 'Pendle',
        members: [{ memberName: 'TN Lee', avatarUrl: null, memberLink: { xLink: 'https://x.com/tnlee', linkedinLink: null } }],
      };
      const out = await normalize({
        record,
        evidence: evidenceWith([]),
        env: { ROOTDATA_API_KEY: 'test-key' },
        searchRootData: async () => ({
          ok: true,
          results: [
            {
              name: 'TN Lee',
              introduce: 'TN Lee is an unrelated investor.',
              logo: 'https://public.rootdata.com/images/tn.jpg',
            },
          ],
        }),
      });
      assert.equal(out.record.members[0].avatarUrl, 'https://unavatar.io/x/tnlee?fallback=false');
      assert.equal(out.changes[0].source, 'unavatar:x');
    },
  },
  {
    name: 'LinkedIn profile is used as a secondary paid Unavatar source',
    fn: async () => {
      const record = baseRecord([
        { memberName: 'Alice Liu', avatarUrl: null, memberLink: { xLink: null, linkedinLink: 'https://www.linkedin.com/in/alice-liu/' } },
      ]);
      const out = await normalize({ record, evidence: evidenceWith([], 'skipped: missing env ROOTDATA_API_KEY') });
      assert.equal(out.record.members[0].avatarUrl, 'https://unavatar.io/linkedin/user:alice-liu?fallback=false');
      assert.equal(out.gaps.length, 0);
      assert.equal(out.changes[0].source, 'unavatar:linkedin');
    },
  },
  {
    name: 'RootData pbs.twimg.com URL is ignored; missing Unavatar source records gap',
    fn: async () => {
      const record = baseRecord([{ memberName: 'Alice Liu', avatarUrl: null }]);
      const evidence = evidenceWith([
        { name: 'Alice Liu', avatar_url: 'https://pbs.twimg.com/profile_images/abc.jpg' },
      ]);
      const out = await normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, null);
      assert.equal(out.gaps.length, 1);
      assert.match(out.gaps[0].reason, /paid Unavatar lookup/);
      // No change recorded: before=null, after=null is a no-op for change log.
      assert.equal(out.changes.length, 0);
    },
  },
  {
    name: 'invalid / non-https RootData URLs are ignored',
    fn: async () => {
      const cases = [
        { url: '', reason: 'empty' },
        { url: '   ', reason: 'empty' },
        { url: 'not a url', reason: 'invalid_url' },
        { url: 'http://cdn.rootdata.com/x.png', reason: 'non_https' },
      ];
      for (const c of cases) {
        const record = baseRecord([{ memberName: 'X Y', avatarUrl: null }]);
        const evidence = evidenceWith([{ name: 'X Y', avatar_url: c.url }]);
        const out = await normalize({ record, evidence });
        assert.equal(out.record.members[0].avatarUrl, null, `case ${c.reason}: avatar should be null`);
        assert.equal(out.gaps.length, 1, `case ${c.reason}: one gap expected`);
        assert.match(out.gaps[0].reason, /paid Unavatar lookup/);
      }
    },
  },
  {
    name: 'rootdata fetcher disabled → existing field preserved, no per-member gap',
    fn: async () => {
      const record = baseRecord([
        { memberName: 'Alice Liu', avatarUrl: 'https://unavatar.io/x/aliceliu?fallback=false' },
      ]);
      const evidence = {
        fetcher_status: { rootdata: 'skipped: missing env ROOTDATA_API_KEY' },
      };
      const out = await normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, 'https://unavatar.io/x/aliceliu?fallback=false');
      // Per-run status already recorded in meta.json; no per-member noise.
      assert.equal(out.gaps.length, 0);
      assert.equal(out.changes.length, 0);
    },
  },
  {
    name: 'rootdata fetcher disabled with no existing avatar → Unavatar from X link',
    fn: async () => {
      const record = baseRecord([
        { memberName: 'Alice Liu', avatarUrl: null, memberLink: { xLink: 'https://twitter.com/aliceliu/status/1', linkedinLink: null } },
      ]);
      const evidence = {
        fetcher_status: { rootdata: 'skipped: missing env ROOTDATA_API_KEY' },
      };
      const out = await normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, 'https://unavatar.io/x/aliceliu?fallback=false');
      assert.equal(out.gaps.length, 0);
      assert.equal(out.changes.length, 1);
    },
  },
  {
    name: 'no members → no-op',
    fn: async () => {
      const out = await normalize({ record: { members: [] }, evidence: evidenceWith([]) });
      assert.deepEqual(out.changes, []);
      assert.deepEqual(out.gaps, []);
    },
  },
  {
    name: 'mixed social, handle-like, and missing sources across multiple members',
    fn: async () => {
      const record = baseRecord([
        { memberName: 'Alice', avatarUrl: null, memberLink: { xLink: 'https://x.com/alice', linkedinLink: null } },
        { memberName: 'Bob', avatarUrl: null },
        { memberName: '0xCharlie', avatarUrl: null },
      ]);
      const evidence = evidenceWith([
        { name: 'Alice', avatar_url: 'https://cdn.rootdata.com/alice.png' },
        { name: 'Bob', avatar_url: 'https://pbs.twimg.com/profile_images/b.jpg' },
        // Charlie absent
      ]);
      const out = await normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, 'https://cdn.rootdata.com/alice.png');
      assert.equal(out.record.members[1].avatarUrl, null);
      assert.equal(out.record.members[2].avatarUrl, 'https://unavatar.io/0xCharlie?fallback=false');
      assert.equal(out.gaps.length, 1);
      assert.equal(out.changes.length, 2);
      assert.equal(out.changes[0].entity_key, 'member:Alice');
    },
  },
  {
    name: 'already-rehosted OneKey member CDN URL is preserved',
    fn: async () => {
      const record = baseRecord([{ memberName: 'Alex Smith', avatarUrl: 'https://uni.onekey-asset.com/static/logo/protocol-member-logo/pendle-alex-smith.png' }]);
      const out = await normalize({ record, evidence: evidenceWith([]) });
      assert.equal(out.record.members[0].avatarUrl, 'https://uni.onekey-asset.com/static/logo/protocol-member-logo/pendle-alex-smith.png');
      assert.equal(out.changes.length, 0);
      assert.equal(out.gaps.length, 0);
    },
  },
];
