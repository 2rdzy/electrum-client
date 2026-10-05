'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { startServer } = require('./helpers/server.js');
const { withClient } = require('./helpers/client.js');

describe('limits', () => {
	test('drops the connection and reports an error when a message grows past maxBuffer', async () => {
		const server = await startServer({ handler: request => request.method === 'server.version' ? ['t', '1.4'] : request.params });
		const errors = [];
		let closed;
		const closedPromise = new Promise(resolve => { closed = resolve; });

		try {
			await withClient(server, 'tcp', async client => {
				server.write('x'.repeat(5000));

				await closedPromise;

				assert.match(errors[0].message, /without a message delimiter/);
			}, { options: { maxBuffer: 1000 }, callbacks: { onError: e => errors.push(e), onClose: () => closed() } });

		} finally {
			await server.close();
		}
	});
});
