import {lookup} from 'node:dns/promises'
import net from 'node:net'

// The server fetches whatever url a stranger pastes. Refuse anything that
// points back into the host's own network: loopback, link-local (cloud
// metadata), private ranges, and the serverless runtime API on localhost.

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip)
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      return (n & mask) === (v4ToInt(base) & mask)
    })
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1]
    if (mapped) return isPrivateIp(mapped)
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith('ff')
    )
  }
  return true
}

export class BlockedUrlError extends Error {}

/** Local testing against a dev server on localhost. Never honored in production builds. */
const allowPrivate = process.env.NODE_ENV !== 'production' && process.env.YOINKS_ALLOW_PRIVATE_URLS === '1'

/** Throws unless the url is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BlockedUrlError('That doesn’t look like a link.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError('Only http and https links can be yoinked.')
  }
  if (allowPrivate) return url
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new BlockedUrlError('That link points at a private network.')
  }
  const addresses = net.isIP(host) ? [host] : await resolveAll(host)
  if (addresses.length === 0 || addresses.some(isPrivateIp)) {
    throw new BlockedUrlError('That link points at a private network.')
  }
  return url
}

async function resolveAll(host: string): Promise<string[]> {
  try {
    const results = await lookup(host, {all: true, verbatim: true})
    return results.map(r => r.address)
  } catch {
    throw new BlockedUrlError(`Couldn’t find the site “${host}”.`)
  }
}
