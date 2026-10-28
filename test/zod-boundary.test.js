import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Three values demonstrate GHSA-mrhx-c7xc-m3w5 without a memory/load test.
for (const compiled of [false, true]) {
  for (const kind of ['array', 'set', 'map']) {
    test(`bounded ${kind}, compiled=${compiled}, rejects before visiting elements`, () => {
      let visits = 0;
      const element = z.preprocess(value => { visits++; return value; }, z.string());
      const schema = kind === 'array' ? z.array(element).max(2)
        : kind === 'set' ? z.set(element).max(2) : z.map(z.string(), element).max(2);
      const parser = compiled ? z.compile(schema) : schema;
      const input = values => kind === 'array' ? values : kind === 'set' ? new Set(values)
        : new Map(values.map((value, index) => [String(index), value]));
      for (const values of [['a', 'b', 'c'], [1, 2, 3]]) {
        const rejected = parser.safeParse(input(values));
        assert.equal(rejected.success, false);
        assert.equal(visits, 0);
        assert.equal(rejected.error.issues.length, 1);
      }
      assert.equal(parser.safeParse(input(['a', 'b'])).success, true);
      assert.equal(visits, 2);
    });
  }
}

test('real MCP SDK argument validation rejects bounded arrays before element work', async () => {
  let visits = 0;
  const schema = z.array(z.preprocess(value => { visits++; return value; }, z.string())).max(2);
  const server = new McpServer({ name: 'offline-boundary', version: '1.0.0' });
  const tool = server.tool('bounded', { items: schema }, async () => ({ content: [] }));
  for (const items of [['a', 'b', 'c'], [1, 2, 3]]) {
    await assert.rejects(server.validateToolInput(tool, { items }, 'bounded'), error => error.code === -32602);
    assert.equal(visits, 0);
  }
  assert.deepEqual(await server.validateToolInput(tool, { items: ['a', 'b'] }, 'bounded'), { items: ['a', 'b'] });
  assert.equal(visits, 2);
});
