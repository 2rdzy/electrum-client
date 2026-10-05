/**
 * Simple wrapper to mimick Socket class from NET package, since TLS package has slightly different API.
 * We implement several methods that TCP sockets are expected to have. We will proxy call them as soon as
 * real TLS socket will be created (TLS socket created after connection).
 */
function normalizeFingerprint(fingerprint) {
	return String(fingerprint).replace(/:/g, '').toLowerCase();
}

class TlsSocketWrapper {
	/**
	 * tlsOptions (all optional):
	 *   rejectUnauthorized  verify the server certificate (default true)
	 *   ca                  certificate authority (PEM string/Buffer, or an array) to trust in addition to the defaults
	 *   fingerprint256      accept only the certificate with this SHA-256 fingerprint (hex, colons optional);
	 *                       when set, it replaces chain and host name verification, so it suits self-signed servers
	 *   servername          name to send for SNI and to check the certificate against
	 * Any other key is passed through to tls.connect().
	 */
	constructor(tls, tlsOptions) {
		this._tls = tls; // dependency injection lol
		this._tlsOptions = tlsOptions || {};
		this._socket = false;
		// defaults:
		this._timeout = 5000;
		this._encoding = 'utf8';
		this._keepAliveEneblad = true;
		this._keepAliveinitialDelay = 0;
		this._noDelay = true;
		this._listeners = {};
	}

	setTimeout(timeout) {
		if (this._socket) this._socket.setTimeout(timeout);
		this._timeout = timeout;
	}

	setEncoding(encoding) {
		if (this._socket) this._socket.setEncoding(encoding);
		this._encoding = encoding;
	}

	setKeepAlive(enabled, initialDelay) {
		if (this._socket) this._socket.setKeepAlive(enabled, initialDelay);
		this._keepAliveEneblad = enabled;
		this._keepAliveinitialDelay = initialDelay;
	}

	setNoDelay(noDelay) {
		if (this._socket) this._socket.setNoDelay(noDelay);
		this._noDelay = noDelay;
	}

	on(event, listener) {
		this._listeners[event] = this._listeners[event] || [];
		this._listeners[event].push(listener);
	}

	removeListener(event, listener) {
		this._listeners[event] = this._listeners[event] || [];
		let newListeners = [];

		let found = false;
		for (let savedListener of this._listeners[event]) {
			if (savedListener == listener) {
				// found our listener
				found = true;
				// we just skip it
			} else {
				// other listeners should go back to original array
				newListeners.push(savedListener);
			}
		}

		if (found) {
			this._listeners[event] = newListeners;
		} else {
			// something went wrong, lets just cleanup all listeners
			this._listeners[event] = [];
		}
	}

	connect(port, host, callback) {
		// resulting TLSSocket extends <net.Socket>
		const { fingerprint256, ...tlsOptions } = this._tlsOptions;
		const pin = fingerprint256 ? normalizeFingerprint(fingerprint256) : null;

		this._socket = this._tls.connect({
			rejectUnauthorized: true,
			...tlsOptions,
			// a pinned certificate is trusted by its fingerprint alone
			...(pin ? { rejectUnauthorized: false } : {}),
			port: port,
			host: host
		}, () => {
			if (pin) {
				const cert = this._socket.getPeerCertificate();
				const actual = cert && cert.fingerprint256 ? normalizeFingerprint(cert.fingerprint256) : null;

				if (actual !== pin) {
					this._socket.destroy(new Error('Server certificate does not match the pinned fingerprint'));
					return;
				}
			}

			return callback();
		});

		// setting everything that was set to this proxy class

		this._socket.setTimeout(this._timeout);
		this._socket.setEncoding(this._encoding);
		this._socket.setKeepAlive(this._keepAliveEneblad, this._keepAliveinitialDelay);
		this._socket.setNoDelay(this._noDelay);

		// resubscribing to events on newly created socket so we could proxy them to already established listeners

		this._socket.on('data', data => {
			this._passOnEvent('data', data);
		});
		this._socket.on('error', data => {
			this._passOnEvent('error', data);
		});
		this._socket.on('close', data => {
			this._passOnEvent('close', data);
		});
		this._socket.on('connect', data => {
			this._passOnEvent('connect', data);
		});
		this._socket.on('connection', data => {
			this._passOnEvent('connection', data);
		});
	}

	_passOnEvent(event, data) {
		this._listeners[event] = this._listeners[event] || [];
		for (let savedListener of this._listeners[event]) {
			savedListener(data);
		}
	}

	emit(event, data) {
		this._socket.emit(event, data);
	}

	end() {
		this._socket.end();
	}

	destroy() {
		this._socket.destroy();
	}

	write(data) {
		this._socket.write(data);
	}
}

module.exports = TlsSocketWrapper;
