'use strict';

// The client expects net and tls to be injected as globals (see lib/client.js).
global.net = require('net');
global.tls = require('tls');

const ElectrumClient = require('../../index.js');

// Connect a client to `server`, run `fn(client)`, and always close the client.
async function withClient(server, protocol, fn, { options, callbacks } = {}) {
	const client = new ElectrumClient(server.port, '127.0.0.1', protocol, options, callbacks);

	await client.initElectrum({ client: 'electrum-client-test', version: '1.4' }, { retryPeriod: 100000, maxRetry: 0, callback: () => {} });

	try {
		return await fn(client);

	} finally {
		client.close();
	}
}

module.exports = { ElectrumClient, withClient };
