'use strict';

const makeRequest = (exports.makeRequest = (method, params, id) => {
	return JSON.stringify({
		jsonrpc: '2.0',
		method: method,
		params: params,
		id: id,
	});
});

const createPromiseResult = (exports.createPromiseResult = (resolve, reject) => {
	return (err, result) => {
		if (err) reject(err);
		else resolve(result);
	};
});

const createPromiseResultBatch = (exports.createPromiseResultBatch = (resolve, reject, argz) => {
	return (err, result) => {
		if (result && result[0] && result[0].id) {
			// this is a batch request response
			for (let r of result) {
				r.param = argz[r.id];
			}
		}
		if (err) reject(err);
		else resolve(result);
	};
});

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

class MessageParser {
	constructor(callback, delimiter = '\n', maxBuffer = DEFAULT_MAX_BUFFER) {
		this.buffer = '';
		this.callback = callback;
		this.delimiter = delimiter;
		this.maxBuffer = maxBuffer;
	}

	// Feed received text; the callback gets each complete message. Each message
	// is cut out with a single indexOf, so a large reply costs time linear in its size.
	run(chunk) {
		this.buffer += chunk;

		let start = 0;
		let end;
		let n = 0;
		while ((end = this.buffer.indexOf(this.delimiter, start)) !== -1) {
			const body = this.buffer.slice(start, end);
			start = end + this.delimiter.length;

			if (body.length > 0) {
				this.callback(body, n++);
			}
		}

		this.buffer = start > 0 ? this.buffer.slice(start) : this.buffer;

		if (this.buffer.length > this.maxBuffer) {
			// a message that never ends: stop holding on to it
			this.buffer = '';

			throw new Error(`Received more than ${this.maxBuffer} bytes without a message delimiter`);
		}
	}
}
exports.MessageParser = MessageParser;
