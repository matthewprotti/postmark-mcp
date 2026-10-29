import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// The executable deliberately validates its Postmark account at startup.
// Replace every external boundary before importing it; never load local secrets.
process.env.POSTMARK_SERVER_TOKEN = 'offline-test-token';
process.env.DEFAULT_SENDER_EMAIL = 'sender@example.com';
process.env.DEFAULT_MESSAGE_STREAM = 'test-stream';
globalThis.fetch = async () => { throw new Error('Unexpected real fetch'); };
mock.module('dotenv/config', { namedExports: {} });
const calls = [];
let providerError = false;
let templates = [];
let stats = {};
let statsError = false;
const record = (method, data) => {
  calls.push({ method, data });
  if (providerError) throw new Error('Synthetic provider failure');
};
mock.module('postmark', { defaultExport: {
  ServerClient: class {
    constructor(token) { assert.equal(token, 'offline-test-token'); }
    async getServer() { record('getServer'); return { ID: 1 }; }
    async sendEmail(data) { record('sendEmail', data); return { MessageID: 'offline-message' }; }
    async sendEmailWithTemplate(data) { record('sendEmailWithTemplate', data); return { MessageID: 'offline-template' }; }
    async getTemplates() { record('getTemplates'); return { Templates: templates }; }
  }
} });
mock.module('node-fetch', { defaultExport: async (url, options) => {
  assert.ok(url.startsWith('https://api.postmarkapp.com/stats/outbound'));
  assert.equal(options.headers['X-Postmark-Server-Token'], 'offline-test-token');
  calls.push({ method: 'stats', url });
  return { ok: !statsError, status: 503, statusText: 'Offline test failure', json: async () => stats };
} });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
let ready;
const started = new Promise(resolve => { ready = resolve; });
const start = serverTransport.start.bind(serverTransport);
serverTransport.start = async () => { await start(); ready(); };
mock.module('@modelcontextprotocol/sdk/server/stdio.js', {
  namedExports: { StdioServerTransport: class { constructor() { return serverTransport; } } }
});
await import('../index.js');
await started;
const client = new Client({ name: 'offline-compatibility', version: '1.0.0' });
await client.connect(clientTransport);
after(() => client.close());
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const successful = result => assert.notEqual(result.isError, true);

test('startup and discovery use the real SDK and advertise four input schemas', async () => {
  assert.equal(calls.filter(x => x.method === 'getServer').length, 1);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(x => x.name).sort(), ['getDeliveryStats', 'listTemplates', 'sendEmail', 'sendEmailWithTemplate']);
  for (const tool of tools) assert.equal(tool.inputSchema.type, 'object');
  const send = tools.find(x => x.name === 'sendEmail');
  assert.deepEqual(send.inputSchema.required, ['to', 'subject', 'textBody']);
});

test('ordinary and tagged recipient addresses preserve defaults and tracking', async () => {
  for (const to of ['normal@example.com', 'first+tag@example.com', "o'hara@example.com"]) {
    successful(await call('sendEmail', { to, subject: 'Offline', textBody: 'Synthetic body' }));
    assert.deepEqual(calls.at(-1).data, {
      From: 'sender@example.com', To: to, Subject: 'Offline', TextBody: 'Synthetic body',
      MessageStream: 'test-stream', TrackOpens: true, TrackLinks: 'HtmlAndText'
    });
  }
});

test('optional sender, HTML and tag remain intact', async () => {
  successful(await call('sendEmail', { to: 'to@example.com', subject: '', textBody: '',
    from: 'other@example.com', htmlBody: '<p>synthetic</p>', tag: 'test' }));
  assert.equal(calls.at(-1).data.From, 'other@example.com');
  assert.equal(calls.at(-1).data.HtmlBody, '<p>synthetic</p>');
  assert.equal(calls.at(-1).data.Tag, 'test');
});

test('invalid input is rejected before a provider call', async () => {
  const before = calls.length;
  for (const args of [
    { to: 'invalid', subject: 'x', textBody: 'x' },
    { to: 'to@example.com', subject: 42, textBody: 'x' },
    { to: ['to@example.com'], subject: 'x', textBody: 'x' },
    { to: 'to@example.com', textBody: 'x' }
  ]) assert.equal((await call('sendEmail', args)).isError, true);
  assert.equal(calls.length, before);
});

test('template model passthrough, ID precedence and alias paths are preserved', async () => {
  const model = { Name: 'Synthetic', rows: [{ title: 'a' }, { title: 'b' }], nested: { enabled: true } };
  successful(await call('sendEmailWithTemplate', { to: 'to@example.com', templateId: 7,
    templateAlias: 'ignored-with-id', templateModel: model, tag: 'test' }));
  assert.deepEqual(calls.at(-1).data.TemplateModel, model);
  assert.equal(calls.at(-1).data.TemplateId, 7);
  assert.equal(calls.at(-1).data.TemplateAlias, undefined);
  successful(await call('sendEmailWithTemplate', { to: 'to@example.com', templateAlias: 'welcome',
    templateModel: model, from: 'other@example.com' }));
  assert.equal(calls.at(-1).data.TemplateAlias, 'welcome');
  assert.equal(calls.at(-1).data.From, 'other@example.com');
  const before = calls.length;
  assert.equal((await call('sendEmailWithTemplate', { to: 'to@example.com', templateModel: model })).isError, true);
  assert.equal(calls.length, before);
});

test('template listing handles empty and populated provider results', async () => {
  templates = [];
  assert.match((await call('listTemplates')).content[0].text, /Found 0 templates/);
  templates = [{ Name: 'Example', TemplateId: 7, Alias: 'welcome', Subject: 'Hello' }];
  const result = await call('listTemplates');
  successful(result);
  assert.match(result.content[0].text, /Found 1 templates/);
  assert.match(result.content[0].text, /welcome/);
});

test('delivery statistics encode filters and preserve zero-denominator behavior', async () => {
  stats = {};
  const empty = await call('getDeliveryStats');
  assert.match(empty.content[0].text, /Open Rate: 0.0%/);
  assert.match(empty.content[0].text, /Click Rate: 0.0%/);
  stats = { Sent: 10, Tracked: 8, UniqueOpens: 4, TotalTrackedLinksSent: 4, UniqueLinksClicked: 1 };
  const result = await call('getDeliveryStats', { tag: 'a&b', fromDate: '2026-10-01', toDate: '2026-10-27' });
  assert.match(result.content[0].text, /Open Rate: 50.0%/);
  assert.match(result.content[0].text, /Click Rate: 25.0%/);
  assert.equal(calls.at(-1).url, 'https://api.postmarkapp.com/stats/outbound?fromdate=2026-10-01&todate=2026-10-27&tag=a%26b');
  const before = calls.length;
  assert.equal((await call('getDeliveryStats', { fromDate: '27/10/2026' })).isError, true);
  assert.equal(calls.length, before);
});

test('provider and fetch failures remain MCP error results', async () => {
  providerError = true;
  try {
    const result = await call('sendEmail', { to: 'to@example.com', subject: 'x', textBody: 'x' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Synthetic provider failure/);
  } finally { providerError = false; }
  statsError = true;
  try { assert.equal((await call('getDeliveryStats')).isError, true); }
  finally { statsError = false; }
});
