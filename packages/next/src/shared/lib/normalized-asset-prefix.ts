export function normalizedAssetPrefix(assetPrefix: string | undefined): string {
  // remove all leading slashes
  const escapedAssetPrefix = assetPrefix?.replace(/^\/+/, '') || false

  // if an assetPrefix was '/', we return empty string
  // because it could be an unnecessary trailing slash
  if (!escapedAssetPrefix) {
    return ''
  }

  if (URL.canParse(escapedAssetPrefix)) {
    const { hostname, port, protocol, pathname } = new URL(escapedAssetPrefix)
    return `${protocol}//${hostname}${port ? `:${port}` : ''}${pathname}`
  }

  // assuming assetPrefix here is a pathname-style,
  // restore the leading slash
  return `/${escapedAssetPrefix}`
}
