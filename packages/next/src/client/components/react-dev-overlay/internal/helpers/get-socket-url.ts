import { normalizedAssetPrefix } from '../../../../../shared/lib/normalized-asset-prefix'

function getSocketProtocol(assetPrefix: string): string {
  let protocol = window.location.protocol

  try {
    // assetPrefix is a url
    protocol = new URL(assetPrefix).protocol
  } catch {}

  return protocol === 'http:' ? 'ws:' : 'wss:'
}

export function getSocketUrl(assetPrefix: string | undefined): string {
  const prefix = normalizedAssetPrefix(assetPrefix)
  const protocol = getSocketProtocol(assetPrefix || '')

  if (URL.canParse(prefix)) {
    // since normalized asset prefix is ensured to be in URL format,
    // we can trust to simply replace the protocol
    return prefix.replace(/^http/, 'ws')
  }

  const { hostname, port } = window.location
  return `${protocol}//${hostname}${port ? `:${port}` : ''}${prefix}`
}
