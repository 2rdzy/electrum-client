'use strict';

// A minimal Electrum-protocol server for tests: newline-delimited JSON-RPC over
// TCP or TLS. `handler(request)` returns the result for a request, or throws
// `{code, message}` to send an error.

const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');

const fixtures = path.join(__dirname, '..', 'fixtures');

const tlsOptions = {
	key: fs.readFileSync(path.join(fixtures, 'key.pem')),
	cert: fs.readFileSync(path.join(fixtures, 'cert.pem')),
};

// a handler may return NO_REPLY to leave a request unanswered
const NO_REPLY = Symbol('no reply');

function reply(request, handler) {
	try {
		const result = handler(request);

		if (result === NO_REPLY) {
			return NO_REPLY;
		}

		return { jsonrpc: '2.0', id: request.id, result };

	} catch (err) {
		return { jsonrpc: '2.0', id: request.id, error: { code: err.code || -1, message: err.message || String(err) } };
	}
}

async function startServer({ useTls = false, handler = req => req.params } = {}) {
	const sockets = new Set();
	const received = [];

	const onConnection = socket => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
		socket.setEncoding('utf8');

		let buffer = '';
		socket.on('data', chunk => {
			buffer += chunk;

			let index;
			while ((index = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);

				const message = JSON.parse(line);
				received.push(message);

				const out = Array.isArray(message)
					? message.map(request => reply(request, handler)).filter(r => r !== NO_REPLY)
					: reply(message, handler);

				if (out !== NO_REPLY && !(Array.isArray(out) && out.length === 0)) {
					socket.write(JSON.stringify(out) + '\n');
				}
			}
		});
	};

	const server = useTls ? tls.createServer(tlsOptions, onConnection) : net.createServer(onConnection);

	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

	return {
		port: server.address().port,
		received,
		sockets,
		// send a raw line to every connected client (for notifications and malformed input)
		broadcast: line => sockets.forEach(socket => socket.write(line + '\n')),
		close: () => new Promise(resolve => {
			sockets.forEach(socket => socket.destroy());
			server.close(resolve);
		}),
	};
}

// a TCP server that accepts connections and never says anything (so a TLS handshake stalls)
async function startSilentServer() {
	const sockets = new Set();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on('error', () => {});
	});

	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

	return {
		port: server.address().port,
		close: () => new Promise(resolve => {
			sockets.forEach(socket => socket.destroy());
			server.close(resolve);
		}),
	};
}

module.exports = { startServer, startSilentServer, tlsOptions, NO_REPLY };
