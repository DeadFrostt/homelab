// SOCKS5 boundary between restricted Docker computers and userspace Tailscale.
// Resolve and pin public names here: never let a public name resolve privately
// in the upstream proxy. Known MagicDNS names map to tailnet addresses only.
const net = require('node:net');
const dns = require('node:dns').promises;
const { once } = require('node:events');
const hosts = {
  yeager: '100.105.150.16', springer: '100.112.158.118', ackermann: '100.122.24.109',
};
function allowed(ip, port) {
  if (port === 6443 || net.isIP(ip) !== 4) return false;
  const [a,b] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)));
}
async function target(host, port) {
  const name = host.toLowerCase().replace(/\.$/, '').replace(/\.angelfish-ruler\.ts\.net$/, '');
  const ip = hosts[name] || (net.isIP(host) ? host : (await dns.lookup(host, {family:4})).address);
  if (!allowed(ip, port)) throw new Error('destination is outside allowed egress');
  return ip;
}
async function read(socket, n) {
  for (;;) {
    const data = socket.read(n);
    if (data) return data;
    if (socket.destroyed || socket.readableEnded) throw new Error('connection closed');
    await once(socket, 'readable');
  }
}
async function serve(client) {
  let upstream;
  client.setTimeout(30000, () => client.destroy());
  client.on('error', () => upstream?.destroy());
  try {
    const greeting = await read(client, 2);
    const methods = await read(client, greeting[1]);
    if (greeting[0] !== 5 || !methods.includes(0)) {client.end(Buffer.from([5,255])); return;}
    client.write(Buffer.from([5,0]));
    const head = await read(client, 4);
    if (head[0] !== 5 || head[1] !== 1 || head[2] !== 0) throw new Error('CONNECT required');
    let host;
    if (head[3] === 1) host = [...await read(client, 4)].join('.');
    else if (head[3] === 3) host = (await read(client, (await read(client,1))[0])).toString();
    else throw new Error('IPv4 or DNS destination required');
    const portBytes = await read(client,2);
    const ip = await target(host, portBytes.readUInt16BE());
    upstream = net.connect(1055, '127.0.0.1');
    upstream.setTimeout(15000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => client.destroy());
    await once(upstream, 'connect');
    upstream.write(Buffer.from([5,1,0]));
    const auth = await read(upstream,2);
    if (auth[0] !== 5 || auth[1] !== 0) throw new Error('upstream authentication failed');
    upstream.write(Buffer.concat([Buffer.from([5,1,0,1,...ip.split('.').map(Number)]),portBytes]));
    const reply = await read(upstream,4);
    let address;
    if (reply[3] === 1) address = await read(upstream,4);
    else if (reply[3] === 4) address = await read(upstream,16);
    else if (reply[3] === 3) {const size=await read(upstream,1); address=Buffer.concat([size,await read(upstream,size[0])]);}
    else throw new Error('invalid upstream reply');
    client.write(Buffer.concat([reply,address,await read(upstream,2)]));
    if (reply[1] !== 0) {client.end(); upstream.destroy(); return;}
    client.setTimeout(0); upstream.setTimeout(0);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  } catch (error) {
    console.error('proxy:', error.message);
    if (!client.destroyed) client.end(Buffer.from([5,2,0,1,0,0,0,0,0,0]));
    upstream?.destroy();
  }
}
if (require.main === module) {
  net.createServer(client => {void serve(client);}).listen(1056, '172.17.0.1', () => console.log('Rakazo filtered proxy ready'));
}
module.exports = {allowed, target};
