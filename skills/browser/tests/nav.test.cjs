const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/nav.cjs'), 'utf8');

async function run(responses) {
  const methods = [], errors = [], output = [];
  let exit;
  const http = { request(options, callback) {
    methods.push(options.method);
    const req = new EventEmitter();
    req.end = () => setImmediate(() => {
      const [statusCode, body] = responses.shift();
      const res = new EventEmitter();
      res.statusCode = statusCode;
      callback(res);
      res.emit('data', body);
      res.emit('end');
    });
    return req;
  }};
  vm.runInNewContext(source, {
    require: name => { assert.equal(name, 'http'); return http; },
    process: { argv: ['node', 'nav.cjs', 'https://example.com', '--new'], exit: code => { exit = code; } },
    console: { log: text => output.push(text), error: (...args) => errors.push(args.join(' ')) },
  });
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  return { methods, errors, output, exit };
}

test('creates Chrome tab using PUT', async () => {
  const r = await run([[200, '{"id":"tab"}']]);
  assert.deepEqual(r.methods, ['PUT']);
  assert.equal(JSON.parse(r.output[0]).tabId, 'tab');
});
test('falls back to GET only for 405', async () => {
  const r = await run([[405, 'use GET'], [200, '{"id":"old"}']]);
  assert.deepEqual(r.methods, ['PUT', 'GET']);
  assert.equal(JSON.parse(r.output[0]).tabId, 'old');
});
test('reports non-JSON response clearly', async () => {
  const r = await run([[200, '<html>error</html>']]);
  assert.equal(r.exit, 1);
  assert.match(r.errors[0], /non-JSON response.*<html>/);
});
test('reports HTTP errors without fallback', async () => {
  const r = await run([[500, 'broken']]);
  assert.deepEqual(r.methods, ['PUT']);
  assert.match(r.errors[0], /HTTP 500: broken/);
});
