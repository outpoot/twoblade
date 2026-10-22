import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [net, prefix] of [
	['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
	['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
	['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
	['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
	['::ffff:0:0', 96], ['64:ff9b::', 96], ['2002::', 16]
] as const) blocked.addSubnet(net, prefix, 'ipv6');

function addressIsPublic(address: string): boolean {
	const family = isIP(address);
	if (family === 0) return false;
	return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export async function isPublicHost(hostname: string): Promise<boolean> {
	const host = hostname.replace(/^\[|\]$/g, '');
	if (isIP(host)) return addressIsPublic(host);
	if (!host.includes('.') || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
		return false;
	}
	try {
		const records = await lookup(host, { all: true });
		return records.length > 0 && records.every((r) => addressIsPublic(r.address));
	} catch {
		return false;
	}
}
