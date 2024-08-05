export function normalizedAssetPrefix(assetPrefix: string | undefined): string {
  if (assetPrefix && URL.canParse(assetPrefix)) {
    return new URL(assetPrefix).pathname
  }

  const escapedAssetPrefix = assetPrefix?.replace(/^\/+/, '') || false

  // assetPrefix is set to `undefined` or '/'
  if (!escapedAssetPrefix) {
    return ''
  }

  // assetPrefix is a common path but escaped so let's add one leading slash
  return `/${escapedAssetPrefix}`
}
