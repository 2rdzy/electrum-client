'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

const { startServer } = require('./helpers/server.js');
const { withClient } = require('./helpers/client.js');

const handler = request => {
	switch (request.method) {
		case 'server.version': return ['test-server 1.0', '1.4'];
		case 'echo': return request.params;
		case 'blockchain.scripthash.get_balance': return { confirmed: request.params[0].length, unconfirmed: 0 };
		case 'fail': throw { code: 2, message: 'nope' };
		default: throw { code: -32601, message: `unknown method ${request.method}` };
	}
};

for (const [protocol, useTls] of [['tcp', false], ['tls', true]]) {
	describe(`over ${protocol}`, () => {
		let server;

		before(async () => { server = await startServer({ useTls, handler }); });
		after(() => server.close());

		test('negotiates the protocol version', () => withClient(server, protocol, client => {
			assert.deepEqual(client.versionInfo, ['test-server 1.0', '1.4']);
		}));

		test('resolves a request with its result', () => withClient(server, protocol, async client => {
			assert.deepEqual(await client.request('echo', ['a', 1]), ['a', 1]);
		}));

		test('rejects a request with the server error', () => withClient(server, protocol, async client => {
			await assert.rejects(client.request('fail', []), { code: 2, message: 'nope' });
		}));

		test('keeps concurrent requests apart', () => withClient(server, protocol, async client => {
			const results = await Promise.all([1, 2, 3, 4, 5].map(n => client.request('echo', [n])));

			assert.deepEqual(results, [[1], [2], [3], [4], [5]]);
		}));

		test('resolves a batch with one entry per parameter, tagged with it', () => withClient(server, protocol, async client => {
			const results = await client.blockchainScripthash_getBalanceBatch(['aa', 'bbbb', 'cccccc']);

			assert.deepEqual(results.map(r => r.param), ['aa', 'bbbb', 'cccccc']);
			assert.deepEqual(results.map(r => r.result.confirmed), [2, 4, 6]);
		}));

		test('emits subscription notifications', () => withClient(server, protocol, async client => {
			const notified = new Promise(resolve => client.subscribe.once('blockchain.headers.subscribe', resolve));

			server.broadcast(JSON.stringify({ jsonrpc: '2.0', method: 'blockchain.headers.subscribe', params: [{ height: 7 }] }));

			assert.deepEqual(await notified, [{ height: 7 }]);
		}));

		test('refuses requests after close', async () => {
			await withClient(server, protocol, async client => {
				client.close();

				await assert.rejects(client.request('echo', []), /Connection to server lost/);
			});
		});
	});
}

describe('protocol handling', () => {
	let server;

	const handler = request => {
		switch (request.method) {
			case 'server.version': return ['test-server 1.0', '1.4'];
			case 'server.ping': return null;
			case 'zero': return 0;
			case 'empty': return '';
			case 'no': return false;
			case 'echo': return request.params;
			default: throw { code: -32601, message: `unknown method ${request.method}` };
		}
	};

	before(async () => { server = await startServer({ handler }); });
	after(() => server.close());

	test('resolves falsy results as they are', () => withClient(server, 'tcp', async client => {
		assert.equal(await client.server_ping(), null);
		assert.equal(await client.request('zero', []), 0);
		assert.equal(await client.request('empty', []), '');
		assert.equal(await client.request('no', []), false);
	}));

	test('sends blockchain.block.headers', () => withClient(server, 'tcp', async client => {
		await client.blockchainBlock_headers(100, 2).catch(() => {});

		assert.ok(server.received.some(m => m.method === 'blockchain.block.headers' && m.params[0] === 100));
	}));

	test('an empty batch resolves empty and leaves other requests alone', () => withClient(server, 'tcp', async client => {
		const pending = client.request('echo', ['still here']);

		assert.deepEqual(await client.requestBatch('echo', []), []);
		assert.deepEqual(await pending, ['still here']);
	}));

	test('survives a response it did not ask for', () => {
		const errors = [];

		return withClient(server, 'tcp', async client => {
			server.broadcast(JSON.stringify({ jsonrpc: '2.0', id: 99999, result: 'late' }));
			server.broadcast(JSON.stringify({ jsonrpc: '2.0', error: { code: 1, message: 'batch too big' } }));

			assert.deepEqual(await client.request('echo', ['ok']), ['ok']);
			assert.equal(errors.length, 2);
			assert.match(errors[1].message, /batch too big/);
		}, { callbacks: { onError: e => errors.push(e) } });
	});

	test('survives a line that is not JSON', () => {
		const errors = [];

		return withClient(server, 'tcp', async client => {
			server.broadcast('this is not json');

			assert.deepEqual(await client.request('echo', ['ok']), ['ok']);
			assert.match(errors[0].message, /invalid JSON/);
		}, { callbacks: { onError: e => errors.push(e) } });
	});
});
