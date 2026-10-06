# electrum-client

Electrum Protocol Client for node.js.

# based on

* https://github.com/you21979/node-electrum-client
* https://github.com/7kharov/node-electrum-client
* https://github.com/BlueWallet/rn-electrum-client

# features

* persistence (ping strategy and reconnection)
* batch requests
* works in RN and nodejs

## protocol spec

* https://electrumx.readthedocs.io/en/latest/PROTOCOL.html

## usage

Relies on `react-native-tcp` so it should be already installed and linked in RN project. `net` should be provided from outside, this library wont do `require('net')`.
For RN it should be in `shim.js`:

```javascript
  global.net = require('react-native-tcp');
```

For nodejs it should be provided before usage:

```javascript
  global.net = require('net');
```

## TLS (`tls` and `ssl` protocols)

`tls` should be provided as well (`global.tls = require('tls')` in node).

**Since 2.0.0 the server certificate is verified by default.** Pass TLS options in `options.tls` (the fourth constructor argument):

```javascript
const client = new ElectrumClient(50002, 'electrum.example.com', 'tls', {
  tls: {
    // trust a private certificate authority, or the server's own certificate (PEM)
    ca: fs.readFileSync('server-cert.pem'),

    // or accept only the one certificate with this SHA-256 fingerprint (colons and case do not matter).
    // This replaces chain and host name checks, so it suits self-signed servers.
    fingerprint256: 'AB:CD:...',

    // or, for the old behaviour, skip verification. Anyone on the network path can then
    // impersonate the server and read or alter what you send.
    rejectUnauthorized: false
  }
});
```

`servername` sets the name sent for SNI and checked against the certificate. Any other key is passed to node's `tls.connect()`.

To pin a self-signed certificate, get its fingerprint with `openssl x509 -in server-cert.pem -noout -fingerprint -sha256`.

### Upgrading from 1.x

1.x accepted any certificate. If you connect to a server with a self-signed certificate, add `ca` or `fingerprint256`, or set `rejectUnauthorized: false` to keep the old behaviour.
