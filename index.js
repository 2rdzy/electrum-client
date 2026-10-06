'use strict';

const Client = require('./lib/client');

class ElectrumClient extends Client {
	constructor(port, host, protocol, options, callbacks) {
		super(port, host, protocol, options, callbacks);

		this.onConnectCallback = (callbacks && callbacks.onConnect) ? callbacks.onConnect : null;
		this.onCloseCallback = (callbacks && callbacks.onClose) ? callbacks.onClose : null;
		this.onLogCallback = (callbacks && callbacks.onLog) ? callbacks.onLog : function(str) {
			console.log(str);
		};

		this.timeLastCall = 0;
		this.closed = false;
	}

	initElectrum(electrumConfig, persistencePolicy = { retryPeriod: 10000, maxRetry: 1000, pingPeriod: 120000, callback: null }) {
		this.persistencePolicy = persistencePolicy;
		this.electrumConfig = electrumConfig;
		this.timeLastCall = 0;

		return new Promise((resolve, reject) => {
			this.connect().then(() => {
				this.withHandshakeTimeout(this.server_version(this.electrumConfig.client, this.electrumConfig.version)).then((versionInfo) => {
					this.versionInfo = versionInfo;

					if (this.onConnectCallback != null) {
						this.onConnectCallback(this, this.versionInfo);
					}

					resolve(this);

				}).catch((err) => {
					reject(err);
				});
			}).catch((err) => {
				reject(err);
			});
		});
	}

	// A server that accepts the connection but never answers server.version would otherwise
	// leave initElectrum waiting for ever: give up after connectTimeout and drop the connection.
	withHandshakeTimeout(promise) {
		if (!(this.connectTimeout > 0)) {
			return promise;
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.conn.destroy();

				reject(new Error('Timed out waiting for the server version'));
			}, this.connectTimeout);

			if (timer.unref) {
				timer.unref();
			}

			promise.then(
				result => { clearTimeout(timer); resolve(result); },
				err => { clearTimeout(timer); reject(err); }
			);
		});
	}

	// Override parent
	request(method, params) {
		this.timeLastCall = new Date().getTime();

		const parentPromise = super.request(method, params);

		return parentPromise.then(response => {
			this.keepAlive();

			return response;
		});
	}

	requestBatch(method, params, secondParam) {
		this.timeLastCall = new Date().getTime();

		const parentPromise = super.requestBatch(method, params, secondParam);

		return parentPromise.then(response => {
			this.keepAlive();

			return response;
		});
	}

	onClose() {
		super.onClose();

		if (this.closed) {
			return;
		}

		const list = [
			'server.peers.subscribe',
			'blockchain.numblocks.subscribe',
			'blockchain.headers.subscribe',
			'blockchain.address.subscribe',
		];

		list.forEach(event => this.subscribe.removeAllListeners(event));

		var retryPeriod = 10000;
		if (this.persistencePolicy != null && this.persistencePolicy.retryPeriod > 0) {
			retryPeriod = this.persistencePolicy.retryPeriod;
		}

		if (this.onCloseCallback != null) {
			this.onCloseCallback(this);
		}

		if (this.reconnectTimer != null) {
			clearTimeout(this.reconnectTimer);
		}

		this.reconnectTimer = setTimeout(() => {
			if (this.closed) {
				return;
			}

			if (this.persistencePolicy != null && this.persistencePolicy.maxRetry > 0) {
				this.reconnect().catch((err) => {
					this.onError(err);
				});

				this.persistencePolicy.maxRetry -= 1;

			} else if (this.persistencePolicy != null && this.persistencePolicy.callback != null) {
				this.persistencePolicy.callback();

			} else if (this.persistencePolicy == null) {
				this.reconnect().catch((err) => {
					this.onError(err);
				});
			}
		}, retryPeriod);

		// a pending reconnect must not keep the process alive on its own
		if (this.reconnectTimer.unref) {
			this.reconnectTimer.unref();
		}
	}

	// ElectrumX persistancy
	keepAlive() {
		if (this.closed) {
			return;
		}

		if (this.timeout != null) {
			clearTimeout(this.timeout);
		}

		var pingPeriod = 120000;
		if (this.persistencePolicy != null && this.persistencePolicy.pingPeriod > 0) {
			pingPeriod = this.persistencePolicy.pingPeriod;
		}

		this.timeout = setTimeout(() => {
			if (this.timeLastCall !== 0 && new Date().getTime() > this.timeLastCall + pingPeriod) {
				this.server_ping().catch((reason) => {
					this.log(`Keep-Alive ping failed: ${reason}`);
				});
			}
		}, pingPeriod);

		if (this.timeout.unref) {
			this.timeout.unref();
		}
	}

	close() {
		this.closed = true;

		super.close();

		if (this.timeout != null) {
			clearTimeout(this.timeout);
		}

		if (this.reconnectTimer != null) {
			clearTimeout(this.reconnectTimer);
		}
	}

	reconnect() {
		if (this.closed) {
			return Promise.reject(new Error('Client is closed'));
		}

		this.log("Electrum attempting reconnect...");
		
		this.initSocket();

		if (this.persistencePolicy != null) {
			return this.initElectrum(this.electrumConfig, this.persistencePolicy);
			
		} else {
			return this.initElectrum(this.electrumConfig);
		}
	}

	log(str) {
		this.onLogCallback(str);
	}

	// ElectrumX API
	server_version(client_name, protocol_version) {
		return this.request('server.version', [client_name, protocol_version]);
	}
	server_banner() {
		return this.request('server.banner', []);
	}
	server_features() {
		return this.request('server.features', []);
	}
	server_ping() {
		return this.request('server.ping', []);
	}
	server_addPeer(features) {
		return this.request('server.add_peer', [features]);
	}
	serverDonation_address() {
		return this.request('server.donation_address', []);
	}
	serverPeers_subscribe() {
		return this.request('server.peers.subscribe', []);
	}
	blockchainAddress_getProof(address) {
		return this.request('blockchain.address.get_proof', [address]);
	}
	blockchainScripthash_getBalance(scripthash) {
		return this.request('blockchain.scripthash.get_balance', [scripthash]);
	}
	blockchainScripthash_getBalanceBatch(scripthash) {
		return this.requestBatch('blockchain.scripthash.get_balance', scripthash);
	}
	blockchainScripthash_listunspentBatch(scripthash) {
		return this.requestBatch('blockchain.scripthash.listunspent', scripthash);
	}
	blockchainScripthash_getHistory(scripthash) {
		return this.request('blockchain.scripthash.get_history', [scripthash]);
	}
	blockchainScripthash_getHistoryBatch(scripthash) {
		return this.requestBatch('blockchain.scripthash.get_history', scripthash);
	}
	blockchainScripthash_getMempool(scripthash) {
		return this.request('blockchain.scripthash.get_mempool', [scripthash]);
	}
	blockchainScripthash_listunspent(scripthash) {
		return this.request('blockchain.scripthash.listunspent', [scripthash]);
	}
	blockchainScripthash_subscribe(scripthash) {
		return this.request('blockchain.scripthash.subscribe', [scripthash]);
	}
	blockchainBlock_getHeader(height) {
		return this.request('blockchain.block.get_header', [height]);
	}
	blockchainBlock_headers(start_height, count) {
		return this.request('blockchain.block.headers', [start_height, count]);
	}
	blockchainEstimatefee(number) {
		return this.request('blockchain.estimatefee', [number]);
	}
	blockchainHeaders_subscribe(raw) {
		return this.request('blockchain.headers.subscribe', [raw || false]);
	}
	blockchain_relayfee() {
		return this.request('blockchain.relayfee', []);
	}
	blockchainTransaction_broadcast(rawtx) {
		return this.request('blockchain.transaction.broadcast', [rawtx]);
	}
	blockchainTransaction_get(tx_hash, verbose) {
		return this.request('blockchain.transaction.get', [tx_hash, verbose || false]);
	}
	blockchainTransaction_getBatch(tx_hash, verbose) {
		return this.requestBatch('blockchain.transaction.get', tx_hash, verbose);
	}
	blockchainTransaction_getMerkle(tx_hash, height) {
		return this.request('blockchain.transaction.get_merkle', [tx_hash, height]);
	}
	mempool_getFeeHistogram() {
		return this.request('mempool.get_fee_histogram', []);
	}
	// ---------------------------------
	// protocol 1.1 deprecated method
	// ---------------------------------
	blockchainUtxo_getAddress(tx_hash, index) {
		return this.request('blockchain.utxo.get_address', [tx_hash, index]);
	}
	blockchainNumblocks_subscribe() {
		return this.request('blockchain.numblocks.subscribe', []);
	}
	// ---------------------------------
	// protocol 1.2 deprecated method
	// ---------------------------------
	blockchainBlock_getChunk(index) {
		return this.request('blockchain.block.get_chunk', [index]);
	}
	blockchainAddress_getBalance(address) {
		return this.request('blockchain.address.get_balance', [address]);
	}
	blockchainAddress_getHistory(address) {
		return this.request('blockchain.address.get_history', [address]);
	}
	blockchainAddress_getMempool(address) {
		return this.request('blockchain.address.get_mempool', [address]);
	}
	blockchainAddress_listunspent(address) {
		return this.request('blockchain.address.listunspent', [address]);
	}
	blockchainAddress_subscribe(address) {
		return this.request('blockchain.address.subscribe', [address]);
	}
}

module.exports = ElectrumClient;
