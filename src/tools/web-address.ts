import net from 'node:net';

function publicIPv4(address: string): boolean {
  const [a, b, c, d] = address.split('.').map(Number);
  return (
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(
      a === 192 &&
      (b === 168 ||
        (b === 0 && (c === 2 || (c === 0 && d !== 9 && d !== 10))) ||
        (b === 88 && c === 99))
    ) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113) &&
    address !== '168.63.129.16' &&
    a < 224
  );
}

function ipv6Words(address: string): number[] {
  // URL normalizes dotted IPv4 tails and equivalent compressed IPv6 spellings.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const halves = normalized.split('::');
  const words = (part: string) => (part ? part.split(':').map((word) => parseInt(word, 16)) : []);
  const left = words(halves[0]);
  if (halves.length === 1) return left;
  const right = words(halves[1]);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) return publicIPv4(address);
  if (!net.isIPv6(address) || address.includes('%')) return false;
  const words = ipv6Words(address);
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return publicIPv4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.'));
  }
  return (
    (words[0] & 0xe000) === 0x2000 &&
    words[0] !== 0x2002 &&
    !(words[0] === 0x2001 && (words[1] === 0 || words[1] === 0xdb8))
  );
}
