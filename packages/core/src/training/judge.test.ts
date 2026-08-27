import { describe, expect, it } from 'vitest';
import {
  AGGREGATE_JUDGE_SYSTEM_PROMPT,
  VERIFY_JUDGE_SYSTEM_PROMPT,
  parseAggregateJudge,
  parseVerifyJudge,
  judgeAggregate,
  judgeVerification,
} from './judge.js';

describe('parseAggregateJudge', () => {
  it('parses a valid JSON object', () => {
    const result = parseAggregateJudge('{"score":0.8,"winner":"candidate","rationale":"x"}');
    expect(result.score).toBe(0.8);
    expect(result.winner).toBe('candidate');
    expect(result.rationale).toBe('x');
  });

  it('clamps scores to [0,1]', () => {
    expect(parseAggregateJudge('{"score":1.5,"winner":"tie","rationale":""}').score).toBe(1);
    expect(parseAggregateJudge('{"score":-0.2,"winner":"tie","rationale":""}').score).toBe(0);
  });

  it('infers winner from score when the field is missing or invalid', () => {
    expect(parseAggregateJudge('{"score":0.9,"rationale":""}').winner).toBe('candidate');
    expect(parseAggregateJudge('{"score":0.1,"rationale":""}').winner).toBe('reference');
    expect(parseAggregateJudge('{"score":0.5,"rationale":""}').winner).toBe('tie');
  });

  it('extracts from markdown fences', () => {
    const raw = '```json\n{"score":0.4,"winner":"reference","rationale":"r"}\n```';
    const result = parseAggregateJudge(raw);
    expect(result.score).toBe(0.4);
  });
});

describe('parseVerifyJudge', () => {
  it('parses a passed:true response', () => {
    const result = parseVerifyJudge('{"passed":true,"confidence":0.9,"rationale":"covers it"}');
    expect(result.passed).toBe(true);
    expect(result.confidence).toBe(0.9);
  });

  it('parses a passed:false response', () => {
    const result = parseVerifyJudge('{"passed":false,"confidence":0.5,"rationale":"gap"}');
    expect(result.passed).toBe(false);
  });

  it('defaults confidence to 0 when missing', () => {
    expect(parseVerifyJudge('{"passed":true,"rationale":""}').confidence).toBe(0);
  });
});

describe('judge callers use system prompts', () => {
  it('aggregate judge uses the aggregate system prompt', async () => {
    let receivedSystem = '';
    const call = async (opts: any) => {
      receivedSystem = opts.messages[0].content;
      return '{"score":0.5,"winner":"tie","rationale":"x"}';
    };
    await judgeAggregate('ref', 'cand', 'q', { call });
    expect(receivedSystem).toBe(AGGREGATE_JUDGE_SYSTEM_PROMPT);
  });

  it('verify judge uses the verify system prompt', async () => {
    let receivedSystem = '';
    const call = async (opts: any) => {
      receivedSystem = opts.messages[0].content;
      return '{"passed":true,"confidence":0.8,"rationale":"x"}';
    };
    await judgeVerification('mem', 'ans', 'q', { call });
    expect(receivedSystem).toBe(VERIFY_JUDGE_SYSTEM_PROMPT);
  });
});
