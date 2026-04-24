#!/usr/bin/env node
import { translateLocale } from '../translate.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_WRAPPER = join(__dirname, 'mock-claude-wrapper');

let _pass = 0, _fail = 0;
function assert(condition, msg) {
  if (condition) _pass++;
  else { _fail++; console.error(`  FAIL: ${msg}`); }
}
process.on('exit', () => {
  console.log(`  ${_pass} passed, ${_fail} failed`);
  if (_fail > 0) process.exitCode = 1;
});

const sampleInput = {
  description: 'A lending protocol',
  tags: ['lending', 'defi'],
  memberPositions: ['CEO'],
  memberOneLiners: ['Built things'],
  fundingRounds: ['Seed'],
};

// ── Test 1: Successful translation (echo-back mode) ──
{
  delete process.env.MOCK_RESPONSE;
  delete process.env.MOCK_EXIT_CODE;

  try {
    const result = await translateLocale(sampleInput, 'zh-cn', MOCK_WRAPPER);
    assert(result.translated !== undefined, 'got translated field');
    assert(result.cost_usd !== undefined, 'got cost_usd');
    assert(result.translated.description === 'A lending protocol', 'echo-back: description matches');
    assert(result.translated.tags[0] === 'lending', 'echo-back: tags match');
  } catch (e) {
    assert(false, `echo-back test threw: ${e.message}`);
  }
}

// ── Test 2: Custom mock response ──
{
  const mockResponse = JSON.stringify({
    description: '借贷协议',
    tags: ['借贷', '去中心化金融'],
    memberPositions: ['首席执行官'],
    memberOneLiners: ['构建了东西'],
    fundingRounds: ['种子轮'],
  });

  process.env.MOCK_RESPONSE = mockResponse;
  delete process.env.MOCK_EXIT_CODE;

  try {
    const result = await translateLocale(sampleInput, 'zh-cn', MOCK_WRAPPER);
    assert(result.translated.description === '借贷协议', 'custom response: description');
    assert(result.translated.tags[0] === '借贷', 'custom response: tags');
    assert(result.translated.fundingRounds[0] === '种子轮', 'custom response: fundingRounds');
  } catch (e) {
    assert(false, `custom response test threw: ${e.message}`);
  }

  delete process.env.MOCK_RESPONSE;
}

// ── Test 3: Non-zero exit code ──
{
  process.env.MOCK_EXIT_CODE = '1';
  delete process.env.MOCK_RESPONSE;

  try {
    await translateLocale(sampleInput, 'zh-cn', MOCK_WRAPPER);
    assert(false, 'should have thrown on exit code 1');
  } catch (e) {
    assert(e.message.includes('exited 1'), `error mentions exit code: ${e.message}`);
  }

  delete process.env.MOCK_EXIT_CODE;
}
