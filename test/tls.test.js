'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');

const { startServer } = require('./helpers/server.js');
const { ElectrumClient } = require('./helpers/client.js');

const certPem = fs.readFileSync(path.join(__dirname, 'fixtures', 'cert.pem'));
const fingerprint = new crypto.X509Certificate(certPem).fingerprint256; // AA:BB:...

const initConfig = { client: 'electrum-client-test', version: '1.4' };
const noRetry = { retryPeriod: 10, maxRetry: 0, callback: () => {} };

describe('TLS verification', () => {
	let server;

	before(async () => { server = await startServer({ useTls: true, handler: r => r.method === 'server.version' ? ['t', '1.4'] : r.params }); });
	after(() => server.close());

	async function connect(tlsOptions) {
		const client = new ElectrumClient(server.port, '127.0.0.1', 'tls', { tls: tlsOptions, connectTimeout: 2000 }, { onError: () => {} });

		try {
			await client.initElectrum(initConfig, noRetry);

			return await client.request('echo', ['hello']);

		} finally {
			client.close();
		}
	}

	test('rejects a self-signed certificate by default', async () => {
		await assert.rejects(connect(undefined), /self.signed|unable to verify/i);
	});

	test('accepts it when its certificate is given as a trusted ca', async () => {
		assert.deepEqual(await connect({ ca: certPem }), ['hello']);
	});

	test('accepts any certificate when verification is switched off', async () => {
		assert.deepEqual(await connect({ rejectUnauthorized: false }), ['hello']);
	});

	test('accepts a certificate with the pinned fingerprint (colons and case do not matter)', async () => {
		assert.deepEqual(await connect({ fingerprint256: fingerprint }), ['hello']);
		assert.deepEqual(await connect({ fingerprint256: fingerprint.replace(/:/g, '').toLowerCase() }), ['hello']);
	});

	test('rejects a certificate with another fingerprint, even with verification off', async () => {
		const other = fingerprint.replace(/^../, fingerprint.startsWith('00') ? '01' : '00');

		await assert.rejects(connect({ fingerprint256: other }), /pinned fingerprint/);
		await assert.rejects(connect({ fingerprint256: other, rejectUnauthorized: false }), /pinned fingerprint/);
	});

	test('rejects a trusted certificate that is for another host name', async () => {
		await assert.rejects(connect({ ca: certPem, servername: 'not-the-server.example' }), /altnames|hostname|not in the cert/i);
	});
});
