// framework/evidence-diff.mjs — post-R1 evidence enrichment.
// Computes evidence_diff.funding from the R1 record's investor coverage
// vs RootData api_funding investor lists. Severity buckets:
//   0 missing → none, 1 → low, 2-5 → medium, >5 → high.
// Investor names are normalized via lowercase + suffix strip
// (capital, ventures, labs, fund, partners, investments, group, network).

function normInvestor(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+(capital|ventures|labs|fund|partners|investments|group|network)\s*$/i, '')
    .trim();
}

function severityForMissing(count) {
  if (count > 5) return 'high';
  if (count >= 2) return 'medium';
  if (count >= 1) return 'low';
  return 'none';
}

export function enrichEvidenceDiff({ evidence, record }) {
  const out = structuredClone(evidence || {});
  const r1Investors = new Set(
    (record?.fundingRounds || [])
      .flatMap(r => r.investors || [])
      .map(normInvestor)
      .filter(Boolean)
  );
  const api = out.rootdata?.api_funding || {};
  const apiOrgs = (api.investors_orgs_normalized || []).map(normInvestor).filter(Boolean);
  const missing = apiOrgs.filter(name => !r1Investors.has(name));

  out.evidence_diff = {
    ...(out.evidence_diff || {}),
    funding: {
      severity: apiOrgs.length ? severityForMissing(missing.length) : 'none',
      api_total_funding: api.total_funding || null,
      missing_org_investors: missing,
      api_angel_investors: api.investors_people || [],
    },
  };
  return out;
}
