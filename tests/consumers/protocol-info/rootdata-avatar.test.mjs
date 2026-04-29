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
    name: 'exact name match → avatarUrl overwritten with rootdata logo',
    fn: () => {
      const record = baseRecord([
        { memberName: 'Robert Leshner', avatarUrl: null },
      ]);
      const evidence = evidenceWith([
        { name: 'Robert Leshner', avatar_url: 'https://cdn.rootdata.com/people/robert.png', bucket: 'likely_member' },
      ]);
      const out = normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, 'https://cdn.rootdata.com/people/robert.png');
      assert.equal(out.changes.length, 1);
      assert.equal(out.changes[0].field, 'members[0].avatarUrl');
      assert.equal(out.changes[0].source, 'rootdata.ser_inv');
      assert.equal(out.changes[0].before, null);
      assert.equal(out.changes[0].after, 'https://cdn.rootdata.com/people/robert.png');
      assert.equal(out.gaps.length, 0);
    },
  },
  {
    name: 'name match is case- and whitespace-insensitive',
    fn: () => {
      const record = baseRecord([{ memberName: '  vitalik   buterin ', avatarUrl: null }]);
      const evidence = evidenceWith([
        { name: 'Vitalik Buterin', avatar_url: 'https://cdn.rootdata.com/v.png' },
      ]);
      const out = normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, 'https://cdn.rootdata.com/v.png');
    },
  },
  {
    name: 'overwrites stale unavatar URL left behind by the LLM',
    fn: () => {
      const record = baseRecord([
        { memberName: 'Alice Liu', avatarUrl: 'https://unavatar.io/x/aliceliu?fallback=false' },
      ]);
      const evidence = evidenceWith([
        { name: 'Alice Liu', avatar_url: 'https://cdn.rootdata.com/alice.png' },
      ]);
      const out = normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, 'https://cdn.rootdata.com/alice.png');
      assert.equal(out.changes[0].before, 'https://unavatar.io/x/aliceliu?fallback=false');
      assert.equal(out.changes[0].after, 'https://cdn.rootdata.com/alice.png');
    },
  },
  {
    name: 'no candidate match → avatarUrl set to null + gap recorded',
    fn: () => {
      const record = baseRecord([
        { memberName: '0xngmi', avatarUrl: 'https://unavatar.io/x/0xngmi?fallback=false' },
      ]);
      const evidence = evidenceWith([
        { name: 'Someone Else', avatar_url: 'https://cdn.rootdata.com/x.png' },
      ]);
      const out = normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, null);
      assert.equal(out.gaps.length, 1);
      assert.equal(out.gaps[0].field, 'members[0].avatarUrl');
      assert.match(out.gaps[0].reason, /No matching person/);
      assert.equal(out.changes[0].after, null);
      assert.equal(out.changes[0].reason, 'rootdata_no_match');
    },
  },
  {
    name: 'pbs.twimg.com URL is rejected; field nulled with rejection gap',
    fn: () => {
      const record = baseRecord([{ memberName: 'Alice Liu', avatarUrl: null }]);
      const evidence = evidenceWith([
        { name: 'Alice Liu', avatar_url: 'https://pbs.twimg.com/profile_images/abc.jpg' },
      ]);
      const out = normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, null);
      assert.equal(out.gaps.length, 1);
      assert.match(out.gaps[0].reason, /rejected \(twimg_unstable\)/);
      // No change recorded: before=null, after=null is a no-op for change log.
      assert.equal(out.changes.length, 0);
    },
  },
  {
    name: 'invalid / non-https URLs are rejected',
    fn: () => {
      const cases = [
        { url: '', reason: 'empty' },
        { url: '   ', reason: 'empty' },
        { url: 'not a url', reason: 'invalid_url' },
        { url: 'http://cdn.rootdata.com/x.png', reason: 'non_https' },
      ];
      for (const c of cases) {
        const record = baseRecord([{ memberName: 'X Y', avatarUrl: null }]);
        const evidence = evidenceWith([{ name: 'X Y', avatar_url: c.url }]);
        const out = normalize({ record, evidence });
        assert.equal(out.record.members[0].avatarUrl, null, `case ${c.reason}: avatar should be null`);
        assert.equal(out.gaps.length, 1, `case ${c.reason}: one gap expected`);
        assert.ok(out.gaps[0].reason.includes(c.reason), `case ${c.reason}: gap reason should mention ${c.reason}`);
      }
    },
  },
  {
    name: 'rootdata fetcher disabled → existing field preserved, no per-member gap',
    fn: () => {
      const record = baseRecord([
        { memberName: 'Alice Liu', avatarUrl: 'https://unavatar.io/x/aliceliu?fallback=false' },
      ]);
      const evidence = {
        fetcher_status: { rootdata: 'skipped: missing env ROOTDATA_API_KEY' },
      };
      const out = normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, 'https://unavatar.io/x/aliceliu?fallback=false');
      // Per-run status already recorded in meta.json; no per-member noise.
      assert.equal(out.gaps.length, 0);
      assert.equal(out.changes.length, 0);
    },
  },
  {
    name: 'no members → no-op',
    fn: () => {
      const out = normalize({ record: { members: [] }, evidence: evidenceWith([]) });
      assert.deepEqual(out.changes, []);
      assert.deepEqual(out.gaps, []);
    },
  },
  {
    name: 'mixed match / miss / reject across multiple members',
    fn: () => {
      const record = baseRecord([
        { memberName: 'Alice', avatarUrl: null },
        { memberName: 'Bob', avatarUrl: null },
        { memberName: 'Charlie', avatarUrl: null },
      ]);
      const evidence = evidenceWith([
        { name: 'Alice', avatar_url: 'https://cdn.rootdata.com/alice.png' },
        { name: 'Bob', avatar_url: 'https://pbs.twimg.com/profile_images/b.jpg' },
        // Charlie absent
      ]);
      const out = normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, 'https://cdn.rootdata.com/alice.png');
      assert.equal(out.record.members[1].avatarUrl, null);
      assert.equal(out.record.members[2].avatarUrl, null);
      assert.equal(out.gaps.length, 2); // bob (rejected) + charlie (no match)
      // alice has 1 change (null → URL); bob has 0 (null → null); charlie has 1 (null → null is suppressed,
      // but charlie's incoming is null and after is null — check change count carefully).
      // Actually all three started with avatarUrl: null. Alice ended up with URL → 1 change.
      // Bob: null → null (rejected, no-op for change log).
      // Charlie: null → null (no-op for change log).
      assert.equal(out.changes.length, 1);
      assert.equal(out.changes[0].entity_key, 'member:Alice');
    },
  },
  {
    name: 'first candidate wins when duplicate names appear (fetcher pre-sorted)',
    fn: () => {
      const record = baseRecord([{ memberName: 'Alex Smith', avatarUrl: null }]);
      const evidence = evidenceWith([
        { name: 'Alex Smith', avatar_url: 'https://cdn.rootdata.com/alex-1.png' },
        { name: 'Alex Smith', avatar_url: 'https://cdn.rootdata.com/alex-2.png' },
      ]);
      const out = normalize({ record, evidence });
      assert.equal(out.record.members[0].avatarUrl, 'https://cdn.rootdata.com/alex-1.png');
    },
  },
];
