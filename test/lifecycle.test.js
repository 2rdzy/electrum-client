'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { describe, test } = require('node:test');

const { NO_REPLY, startServer, startSilentServer } = require('./helpers/server.js');
const { ElectrumClient, withClient } = require('./helpers/client.js');
const TlsSocketWrapper = require('../lib/TlsSocketWrapper.js');

const handler = request => {
	switch (request.method) {
		case 'server.version': return ['test-server 1.0', '1.4'];
		case 'hang': return NO_REPLY;
		default: return request.params;
	}
};

const initConfig = { client: 'electrum-client-test', version: '1.4' };
const noRetry = { retryPeriod: 10, maxRetry: 0, callback: () => {} };

describe('timeouts', () => {
	for (const protocol of ['tcp', 'tls']) {
		test(`a stalled ${protocol} connection fails after connectTimeout`, async () => {
			const silent = await startSilentServer();

			try {
				const client = new ElectrumClient(silent.port, '127.0.0.1', protocol, { connectTimeout: 150 }, { onError: () => {} });
				const started = Date.now();

				await assert.rejects(client.initElectrum(initConfig, noRetry), /[Tt]imed out/);
				assert.ok(Date.now() - started < 2000);

				client.close();

			} finally {
				await silent.close();
			}
		});
	}

	test('a request with no reply fails after requestTimeout and is forgotten', async () => {
		const server = await startServer({ handler });

		try {
			await withClient(server, 'tcp', async client => {
				await assert.rejects(client.request('hang', []), /timed out after 100 ms/);

				assert.equal(Object.keys(client.callback_message_queue).length, 0);
				assert.deepEqual(await client.request('echo', ['still works']), ['still works']);
			}, { options: { requestTimeout: 100 } });

		} finally {
			await server.close();
		}
	});

	test('without requestTimeout a request waits', async () => {
		const server = await startServer({ handler });

		try {
			await withClient(server, 'tcp', async client => {
				const outcome = await Promise.race([
					client.request('hang', []).then(() => 'answered', () => 'failed'),
					new Promise(resolve => setTimeout(() => resolve('still waiting'), 300)),
				]);

				assert.equal(outcome, 'still waiting');
			});

		} finally {
			await server.close();
		}
	});
});

describe('close', () => {
	test('rejects requests that are still pending', async () => {
		const server = await startServer({ handler });

		try {
			await withClient(server, 'tcp', async client => {
				const pending = client.request('hang', []);

				client.close();

				await assert.rejects(pending, /Connection closed/);
			});

		} finally {
			await server.close();
		}
	});

	test('does not reconnect afterwards', async () => {
		const server = await startServer({ handler });

		try {
			const client = new ElectrumClient(server.port, '127.0.0.1', 'tcp', null, {});
			await client.initElectrum(initConfig, { retryPeriod: 20, maxRetry: 5, callback: null });

			client.close();
			await new Promise(resolve => setTimeout(resolve, 200));

			assert.equal(server.sockets.size, 0);
			await assert.rejects(client.reconnect(), /closed/);

		} finally {
			await server.close();
		}
	});

	test('leaves nothing running that keeps the process alive', async () => {
		const server = await startServer({ handler });

		try {
			const script = `
				global.net = require('net'); global.tls = require('tls');
				const ElectrumClient = require(${JSON.stringify(path.join(__dirname, '..', 'index.js'))});
				const client = new ElectrumClient(${server.port}, '127.0.0.1', 'tcp', null, {});
				client.initElectrum({ client: 'x', version: '1.4' }, { retryPeriod: 600000, pingPeriod: 600000, maxRetry: 10, callback: null })
					.then(() => client.request('echo', [1]))
					.then(() => server_side_close());
				function server_side_close() { client.close(); }
			`;

			const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
			const exited = new Promise(resolve => child.on('exit', resolve));
			const timer = setTimeout(() => child.kill(), 5000);

			assert.equal(await exited, 0, 'the process should exit by itself after close()');
			clearTimeout(timer);

		} finally {
			await server.close();
		}
	});
});

describe('TlsSocketWrapper', () => {
	test('write before connect throws a clear error; end and destroy are harmless', () => {
		const wrapper = new TlsSocketWrapper(require('tls'));

		assert.throws(() => wrapper.write('x'), /Not connected/);
		wrapper.end();
		wrapper.destroy();
	});

	test('removing an unknown listener keeps the others', () => {
		const wrapper = new TlsSocketWrapper(require('tls'));
		const seen = [];
		const keep = data => seen.push(data);

		wrapper.on('data', keep);
		wrapper.removeListener('data', () => {});
		wrapper._passOnEvent('data', 1);

		assert.deepEqual(seen, [1]);
	});
});
