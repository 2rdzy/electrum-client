'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { MessageParser } = require('../lib/util.js');

function collect(parser, ...chunks) {
	const bodies = [];
	parser.callback = body => bodies.push(body);
	chunks.forEach(chunk => parser.run(chunk));

	return bodies;
}

describe('MessageParser', () => {
	test('splits on newlines and joins messages split across chunks', () => {
		assert.deepEqual(collect(new MessageParser(), 'a\nb', 'c\nd\n'), ['a', 'bc', 'd']);
	});

	test('skips empty lines', () => {
		assert.deepEqual(collect(new MessageParser(), 'a\n\n\nb\n'), ['a', 'b']);
	});

	test('keeps an incomplete message until its end arrives', () => {
		const parser = new MessageParser();

		assert.deepEqual(collect(parser, 'abc'), []);
		assert.deepEqual(collect(parser, 'def\n'), ['abcdef']);
	});

	test('handles more than twenty messages in one chunk', () => {
		const lines = Array.from({ length: 5000 }, (_, i) => `m${i}`);

		assert.deepEqual(collect(new MessageParser(), lines.join('\n') + '\n'), lines);
	});

	test('stays fast on a large chunk of many messages', () => {
		const line = JSON.stringify({ id: 1, result: 'y'.repeat(200) });
		const chunk = (line + '\n').repeat(20000);

		const started = Date.now();
		const bodies = collect(new MessageParser(), chunk);

		assert.equal(bodies.length, 20000);
		assert.ok(Date.now() - started < 2000, 'parsing took too long');
	});

	test('refuses a message that never ends', () => {
		const parser = new MessageParser(() => {}, '\n', 1000);

		assert.throws(() => parser.run('x'.repeat(2000)), /without a message delimiter/);
		assert.equal(parser.buffer, '');
	});
});
