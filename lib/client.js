'use strict';
/**
 * expecting NET & TLS to be injected from outside:
 * for RN it should be in shim.js:
 *		 global.net = require('react-native-tcp');
 *		 global.tls = require('react-native-tcp/tls');
 *
 * for nodejs tests it should be provided before tests:
 *		 global.net = require('net');
 *		 global.tls = require('tls');
 * */
let net = global.net;
let tls = global.tls;
const DEFAULT_CONNECT_TIMEOUT = 5000;

const TlsSocketWrapper = require('./TlsSocketWrapper.js');
const EventEmitter = require('events').EventEmitter;
const util = require('./util');

class Client {

	constructor(port, host, protocol, options, callbacks) {
		this.id = 0;
		this.port = port;
		this.host = host;
		this.callback_message_queue = {};
		this.subscribe = new EventEmitter();
		this.mp = new util.MessageParser((body, n) => {
			this.onMessage(body, n);
		}, '\n', options && options.maxBuffer);
		this._protocol = protocol; // saving defaults
		this._options = options;
		this.connectTimeout = (options && options.connectTimeout !== undefined) ? options.connectTimeout : DEFAULT_CONNECT_TIMEOUT;
		this.requestTimeout = (options && options.requestTimeout) || 0; // 0: wait as long as it takes

		this.onErrorCallback = (callbacks && callbacks.onError) ? callbacks.onError : null;

		this.initSocket(protocol, options);
	}

	initSocket(protocol, options) {
		protocol = protocol || this._protocol;
		options = options || this._options;
		switch (protocol) {
			case 'tcp':
				this.conn = new net.Socket();
				break;
			case 'tls':
			case 'ssl':
				if (!tls) {
					throw new Error("Package 'tls' not available");
				}

				this.conn = new TlsSocketWrapper(tls);

				break;
			default:
				throw new Error('unknown protocol');
		}

		this.conn.setTimeout(this.connectTimeout);
		this.conn.setEncoding('utf8');
		this.conn.setKeepAlive(true, 0);
		this.conn.setNoDelay(true);
		this.conn.on('connect', () => {
			this.onConnect();
		});
		this.conn.on('timeout', () => {
			// only armed until the connection is up (see connectSocket) or data arrives
			this.conn.destroy(new Error('Connection timed out'));
		});
		this.conn.on('close', e => {
			this.onClose(e);
		});
		this.conn.on('data', chunk => {
			this.conn.setTimeout(0);
			this.onRecv(chunk);
		});
		this.conn.on('error', e => {
			this.onError(e);
		});
		this.status = 0;
	}

	connect() {
		if (this.status === 1) {
			return Promise.resolve();
		}
		this.status = 1;
		return this.connectSocket(this.conn, this.port, this.host);
	}

	connectSocket(conn, port, host) {
		return new Promise((resolve, reject) => {
			const errorHandler = e => reject(e);
			const closeHandler = () => reject(new Error('Connection closed before it was established'));

			conn.on('error', errorHandler);
			conn.on('close', closeHandler);

			conn.connect(port, host, () => {
				conn.removeListener('error', errorHandler);
				conn.removeListener('close', closeHandler);

				// connected (for TLS: the handshake is done), so stop the connect timeout
				conn.setTimeout(0);

				resolve();
			});
		});
	}

	close() {
		if (this.status === 0) {
			return;
		}
		this.conn.end();
		this.conn.destroy();
		this.status = 0;

		this.rejectPending(new Error('Connection closed'));
	}

	rejectPending(err) {
		Object.keys(this.callback_message_queue).forEach(key => {
			const callback = this.callback_message_queue[key];
			delete this.callback_message_queue[key];

			callback(err);
		});
	}

	// Register `callback` for the response to request `id`. With a requestTimeout set, fail
	// it (and forget it) when no response arrives in time.
	registerCallback(id, callback) {
		if (!(this.requestTimeout > 0)) {
			this.callback_message_queue[id] = callback;
			return;
		}

		const timer = setTimeout(() => {
			delete this.callback_message_queue[id];

			callback(new Error(`Request timed out after ${this.requestTimeout} ms`));
		}, this.requestTimeout);

		if (timer.unref) {
			timer.unref();
		}

		this.callback_message_queue[id] = (err, result) => {
			clearTimeout(timer);

			callback(err, result);
		};
	}

	request(method, params) {
		if (this.status === 0) {
			return Promise.reject(new Error('Connection to server lost, please retry'));
		}
		return new Promise((resolve, reject) => {
			const id = ++this.id;
			const content = util.makeRequest(method, params, id);
			this.registerCallback(id, util.createPromiseResult(resolve, reject));
			this.conn.write(content + '\n');
		});
	}

	requestBatch(method, params, secondParam) {
		if (this.status === 0) {
			return Promise.reject(new Error('Connection to server lost, please retry'));
		}
		if (params.length === 0) {
			// nothing to send; registering a callback now would overwrite the one for the previous request
			return Promise.resolve([]);
		}
		return new Promise((resolve, reject) => {
			let arguments_far_calls = {};
			let contents = [];
			for (let param of params) {
				const id = ++this.id;
				if (secondParam !== undefined) {
					contents.push(util.makeRequest(method, [param, secondParam], id));
				} else {
					contents.push(util.makeRequest(method, [param], id));
				}
				arguments_far_calls[id] = param;
			}
			const content = '[' + contents.join(',') + ']';
			this.registerCallback(this.id, util.createPromiseResultBatch(resolve, reject, arguments_far_calls));
			// callback will exist only for max id
			this.conn.write(content + '\n');
		});
	}

	response(msg) {
		let callback;
		if (Array.isArray(msg)) {
			// this is a response from batch request: the callback is registered under one of the ids
			for (let m of msg) {
				if (m && m.id && this.callback_message_queue[m.id]) {
					callback = this.callback_message_queue[m.id];
					delete this.callback_message_queue[m.id];
				}
			}
		} else {
			callback = this.callback_message_queue[msg.id];
			delete this.callback_message_queue[msg.id];
		}

		if (!callback) {
			// a late reply (after a close or timeout) or one we never asked for: not worth crashing over
			this.onError(new Error('Received a response that matches no pending request'));
			return;
		}

		if (Array.isArray(msg)) {
			callback(null, msg);
		} else if (msg.error) {
			callback(msg.error);
		} else {
			callback(null, msg.result);
		}
	}

	onMessage(body, n) {
		let msg;
		try {
			msg = JSON.parse(body);

		} catch (err) {
			this.onError(new Error(`Received invalid JSON from server: ${err.message}`));
			return;
		}

		if (msg instanceof Array) {
			this.response(msg);
		} else if (msg === null || typeof msg !== 'object') {
			this.onError(new Error('Received an unexpected message from server'));
		} else if (msg.id !== void 0 && msg.id !== null) {
			this.response(msg);
		} else if (msg.method) {
			this.subscribe.emit(msg.method, msg.params);
		} else if (msg.error) {
			// an error that cannot be tied to a request, such as a rejected batch
			this.onError(new Error(msg.error.message || 'Server error'));
		}
	}

	onConnect() {
	}

	onClose(e) {
		this.status = 0;

		this.rejectPending(new Error('close connect'));
	}

	onRecv(chunk) {
		try {
			this.mp.run(chunk);

		} catch (err) {
			// the server is sending something we refuse to hold: report it and drop the connection
			this.onError(err);
			this.conn.destroy();
		}
	}

	onError(e) {
		if (this.onErrorCallback != null) {
			this.onErrorCallback(e);
		}
	}
}

module.exports = Client;
