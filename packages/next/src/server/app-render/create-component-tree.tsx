import type {
  FlightSegmentPath,
  CacheNodeSeedData,
  PreloadCallbacks,
} from './types'
import React from 'react'
import { isClientReference } from '../../lib/client-reference'
import { getLayoutOrPageModule } from '../lib/app-dir-module'
import type { LoaderTree } from '../lib/app-dir-module'
import { interopDefault } from './interop-default'
import { parseLoaderTree } from './parse-loader-tree'
import type { CreateSegmentPath, AppRenderContext } from './app-render'
import { createComponentStylesAndScripts } from './create-component-styles-and-scripts'
import { getLayerAssets } from './get-layer-assets'
import { hasLoadingComponentInTree } from './has-loading-component-in-tree'
import { validateRevalidate } from '../lib/patch-fetch'
import { PARALLEL_ROUTE_DEFAULT_PATH } from '../../client/components/parallel-route-default'
import { getTracer } from '../lib/trace/tracer'
import { NextNodeServerSpan } from '../lib/trace/constants'
import { StaticGenBailoutError } from '../../client/components/static-generation-bailout'
import type { LoadingModuleData } from '../../shared/lib/app-router-context.shared-runtime'
import type { Params } from '../request/params'

/**
 * Use the provided loader tree to create the React Component tree.
 */
export function createComponentTree(props: {
  createSegmentPath: CreateSegmentPath
  loaderTree: LoaderTree
  parentParams: Params
  rootLayoutIncluded: boolean
  firstItem?: boolean
  injectedCSS: Set<string>
  injectedJS: Set<string>
  injectedFontPreloadTags: Set<string>
  getMetadataReady: () => Promise<void>
  ctx: AppRenderContext
  missingSlots?: Set<string>
  preloadCallbacks: PreloadCallbacks
}): Promise<CacheNodeSeedData> {
  return getTracer().trace(
    NextNodeServerSpan.createComponentTree,
    {
      spanName: 'build component tree',
    },
    () => createComponentTreeInternal(props)
  )
}

function errorMissingDefaultExport(
  pagePath: string,
  convention: string
): never {
  throw new Error(
    `The default export is not a React Component in "${pagePath}/${convention}"`
  )
}

const cacheNodeKey = 'c'

async function createComponentTreeInternal({
  createSegmentPath,
  loaderTree: tree,
  parentParams,
  firstItem,
  rootLayoutIncluded,
  injectedCSS,
  injectedJS,
  injectedFontPreloadTags,
  getMetadataReady,
  ctx,
  missingSlots,
  preloadCallbacks,
}: {
  createSegmentPath: CreateSegmentPath
  loaderTree: LoaderTree
  parentParams: Params
  rootLayoutIncluded: boolean
  firstItem?: boolean
  injectedCSS: Set<string>
  injectedJS: Set<string>
  injectedFontPreloadTags: Set<string>
  getMetadataReady: () => Promise<void>
  ctx: AppRenderContext
  missingSlots?: Set<string>
  preloadCallbacks: PreloadCallbacks
}): Promise<CacheNodeSeedData> {
  const {
    renderOpts: { nextConfigOutput, experimental },
    workStore,
    componentMod: {
      NotFoundBoundary,
      LayoutRouter,
      RenderFromTemplateContext,
      ClientPageRoot,
      ClientSegmentRoot,
      createServerSearchParamsForServerPage,
      createPrerenderSearchParamsForClientPage,
      createServerParamsForServerSegment,
      createPrerenderParamsForClientSegment,
      serverHooks: { DynamicServerError },
      Postpone,
    },
    pagePath,
    getDynamicParamFromSegment,
    isPrefetch,
    query,
  } = ctx

  const { page, layoutOrPagePath, segment, modules, parallelRoutes } =
    parseLoaderTree(tree)

  const { layout, template, error, loading, 'not-found': notFound } = modules

  const injectedCSSWithCurrentLayout = new Set(injectedCSS)
  const injectedJSWithCurrentLayout = new Set(injectedJS)
  const injectedFontPreloadTagsWithCurrentLayout = new Set(
    injectedFontPreloadTags
  )

  const layerAssets = getLayerAssets({
    preloadCallbacks,
    ctx,
    layoutOrPagePath,
    injectedCSS: injectedCSSWithCurrentLayout,
    injectedJS: injectedJSWithCurrentLayout,
    injectedFontPreloadTags: injectedFontPreloadTagsWithCurrentLayout,
  })

  const [Template, templateStyles, templateScripts] = template
    ? await createComponentStylesAndScripts({
        ctx,
        filePath: template[1],
        getComponent: template[0],
        injectedCSS: injectedCSSWithCurrentLayout,
        injectedJS: injectedJSWithCurrentLayout,
      })
    : [React.Fragment]

  const [ErrorComponent, errorStyles, errorScripts] = error
    ? await createComponentStylesAndScripts({
        ctx,
        filePath: error[1],
        getComponent: error[0],
        injectedCSS: injectedCSSWithCurrentLayout,
        injectedJS: injectedJSWithCurrentLayout,
      })
    : []

  const [Loading, loadingStyles, loadingScripts] = loading
    ? await createComponentStylesAndScripts({
        ctx,
        filePath: loading[1],
        getComponent: loading[0],
        injectedCSS: injectedCSSWithCurrentLayout,
        injectedJS: injectedJSWithCurrentLayout,
      })
    : []

  const isLayout = typeof layout !== 'undefined'
  const isPage = typeof page !== 'undefined'
  const { mod: layoutOrPageMod } = await getTracer().trace(
    NextNodeServerSpan.getLayoutOrPageModule,
    {
      hideSpan: !(isLayout || isPage),
      spanName: 'resolve segment modules',
      attributes: {
        'next.segment': segment,
      },
    },
    () => getLayoutOrPageModule(tree)
  )

  /**
   * Checks if the current segment is a root layout.
   */
  const rootLayoutAtThisLevel = isLayout && !rootLayoutIncluded
  /**
   * Checks if the current segment or any level above it has a root layout.
   */
  const rootLayoutIncludedAtThisLevelOrAbove =
    rootLayoutIncluded || rootLayoutAtThisLevel

  const [NotFound, notFoundStyles] = notFound
    ? await createComponentStylesAndScripts({
        ctx,
        filePath: notFound[1],
        getComponent: notFound[0],
        injectedCSS: injectedCSSWithCurrentLayout,
        injectedJS: injectedJSWithCurrentLayout,
      })
    : []

  let dynamic = layoutOrPageMod?.dynamic

  if (nextConfigOutput === 'export') {
    if (!dynamic || dynamic === 'auto') {
      dynamic = 'error'
    } else if (dynamic === 'force-dynamic') {
      // force-dynamic is always incompatible with 'export'. We must interrupt the build
      throw new StaticGenBailoutError(
        `Page with \`dynamic = "force-dynamic"\` couldn't be exported. \`output: "export"\` requires all pages be renderable statically because there is not runtime server to dynamic render routes in this output format. Learn more: https://nextjs.org/docs/app/building-your-application/deploying/static-exports`
      )
    }
  }

  if (typeof dynamic === 'string') {
    // the nested most config wins so we only force-static
    // if it's configured above any parent that configured
    // otherwise
    if (dynamic === 'error') {
      workStore.dynamicShouldError = true
    } else if (dynamic === 'force-dynamic') {
      workStore.forceDynamic = true

      // TODO: (PPR) remove this bailout once PPR is the default
      if (workStore.isStaticGeneration && !experimental.isRoutePPREnabled) {
        // If the postpone API isn't available, we can't postpone the render and
        // therefore we can't use the dynamic API.
        const err = new DynamicServerError(
          `Page with \`dynamic = "force-dynamic"\` won't be rendered statically.`
        )
        workStore.dynamicUsageDescription = err.message
        workStore.dynamicUsageStack = err.stack
        throw err
      }
    } else {
      workStore.dynamicShouldError = false
      workStore.forceStatic = dynamic === 'force-static'
    }
  }

  if (typeof layoutOrPageMod?.fetchCache === 'string') {
    workStore.fetchCache = layoutOrPageMod?.fetchCache
  }

  if (typeof layoutOrPageMod?.revalidate !== 'undefined') {
    validateRevalidate(layoutOrPageMod?.revalidate, workStore.route)
  }

  if (typeof layoutOrPageMod?.revalidate === 'number') {
    ctx.defaultRevalidate = layoutOrPageMod.revalidate as number

    if (
      typeof workStore.revalidate === 'undefined' ||
      (typeof workStore.revalidate === 'number' &&
        workStore.revalidate > ctx.defaultRevalidate)
    ) {
      workStore.revalidate = ctx.defaultRevalidate
    }

    if (
      !workStore.forceStatic &&
      workStore.isStaticGeneration &&
      ctx.defaultRevalidate === 0 &&
      // If the postpone API isn't available, we can't postpone the render and
      // therefore we can't use the dynamic API.
      !experimental.isRoutePPREnabled
    ) {
      const dynamicUsageDescription = `revalidate: 0 configured ${segment}`
      workStore.dynamicUsageDescription = dynamicUsageDescription

      throw new DynamicServerError(dynamicUsageDescription)
    }
  }

  const isStaticGeneration = workStore.isStaticGeneration

  // If there's a dynamic usage error attached to the store, throw it.
  if (workStore.dynamicUsageErr) {
    throw workStore.dynamicUsageErr
  }

  const LayoutOrPage: React.ComponentType<any> | undefined = layoutOrPageMod
    ? interopDefault(layoutOrPageMod)
    : undefined

  /**
   * The React Component to render.
   */
  let MaybeComponent = LayoutOrPage

  if (process.env.NODE_ENV === 'development') {
    const { isValidElementType } = require('next/dist/compiled/react-is')
    if (
      (isPage || typeof MaybeComponent !== 'undefined') &&
      !isValidElementType(MaybeComponent)
    ) {
      errorMissingDefaultExport(pagePath, 'page')
    }

    if (
      typeof ErrorComponent !== 'undefined' &&
      !isValidElementType(ErrorComponent)
    ) {
      errorMissingDefaultExport(pagePath, 'error')
    }

    if (typeof Loading !== 'undefined' && !isValidElementType(Loading)) {
      errorMissingDefaultExport(pagePath, 'loading')
    }

    if (typeof NotFound !== 'undefined' && !isValidElementType(NotFound)) {
      errorMissingDefaultExport(pagePath, 'not-found')
    }
  }

  // Handle dynamic segment params.
  const segmentParam = getDynamicParamFromSegment(segment)

  // Create object holding the parent params and current params
  let currentParams: Params = parentParams
  if (segmentParam && segmentParam.value !== null) {
    currentParams = {
      ...parentParams,
      [segmentParam.param]: segmentParam.value,
    }
  }

  // Resolve the segment param
  const actualSegment = segmentParam ? segmentParam.treeSegment : segment

  //
  // TODO: Combine this `map` traversal with the loop below that turns the array
  // into an object.
  const parallelRouteMap = await Promise.all(
    Object.keys(parallelRoutes).map(
      async (
        parallelRouteKey
      ): Promise<[string, React.ReactNode, CacheNodeSeedData | null]> => {
        const isChildrenRouteKey = parallelRouteKey === 'children'
        const currentSegmentPath: FlightSegmentPath = firstItem
          ? [parallelRouteKey]
          : [actualSegment, parallelRouteKey]

        const parallelRoute = parallelRoutes[parallelRouteKey]

        const notFoundComponent =
          NotFound && isChildrenRouteKey ? <NotFound /> : undefined

        // if we're prefetching and that there's a Loading component, we bail out
        // otherwise we keep rendering for the prefetch.
        // We also want to bail out if there's no Loading component in the tree.
        let childCacheNodeSeedData: CacheNodeSeedData | null = null

        if (
          // Before PPR, the way instant navigations work in Next.js is we
          // prefetch everything up to the first route segment that defines a
          // loading.tsx boundary. (We do the same if there's no loading
          // boundary in the entire tree, because we don't want to prefetch too
          // much) The rest of the tree is deferred until the actual navigation.
          // It does not take into account whether the data is dynamic — even if
          // the tree is completely static, it will still defer everything
          // inside the loading boundary.
          //
          // This behavior predates PPR and is only relevant if the
          // PPR flag is not enabled.
          isPrefetch &&
          (Loading || !hasLoadingComponentInTree(parallelRoute)) &&
          // The approach with PPR is different — loading.tsx behaves like a
          // regular Suspense boundary and has no special behavior.
          //
          // With PPR, we prefetch as deeply as possible, and only defer when
          // dynamic data is accessed. If so, we only defer the nearest parent
          // Suspense boundary of the dynamic data access, regardless of whether
          // the boundary is defined by loading.tsx or a normal <Suspense>
          // component in userspace.
          //
          // NOTE: In practice this usually means we'll end up prefetching more
          // than we were before PPR, which may or may not be considered a
          // performance regression by some apps. The plan is to address this
          // before General Availability of PPR by introducing granular
          // per-segment fetching, so we can reuse as much of the tree as
          // possible during both prefetches and dynamic navigations. But during
          // the beta period, we should be clear about this trade off in our
          // communications.
          !experimental.isRoutePPREnabled
        ) {
          // Don't prefetch this child. This will trigger a lazy fetch by the
          // client router.
        } else {
          // Create the child component

          if (process.env.NODE_ENV === 'development' && missingSlots) {
            // When we detect the default fallback (which triggers a 404), we collect the missing slots
            // to provide more helpful debug information during development mode.
            const parsedTree = parseLoaderTree(parallelRoute)
            if (
              parsedTree.layoutOrPagePath?.endsWith(PARALLEL_ROUTE_DEFAULT_PATH)
            ) {
              missingSlots.add(parallelRouteKey)
            }
          }

          const seedData = await createComponentTreeInternal({
            createSegmentPath: (child) => {
              return createSegmentPath([...currentSegmentPath, ...child])
            },
            loaderTree: parallelRoute,
            parentParams: currentParams,
            rootLayoutIncluded: rootLayoutIncludedAtThisLevelOrAbove,
            injectedCSS: injectedCSSWithCurrentLayout,
            injectedJS: injectedJSWithCurrentLayout,
            injectedFontPreloadTags: injectedFontPreloadTagsWithCurrentLayout,
            // getMetadataReady is used to conditionally throw. In the case of parallel routes we will have more than one page
            // but we only want to throw on the first one.
            getMetadataReady: isChildrenRouteKey
              ? getMetadataReady
              : () => Promise.resolve(),
            ctx,
            missingSlots,
            preloadCallbacks,
          })

          childCacheNodeSeedData = seedData
        }

        // This is turned back into an object below.
        return [
          parallelRouteKey,
          <LayoutRouter
            parallelRouterKey={parallelRouteKey}
            segmentPath={createSegmentPath(currentSegmentPath)}
            // TODO-APP: Add test for loading returning `undefined`. This currently can't be tested as the `webdriver()` tab will wait for the full page to load before returning.
            error={ErrorComponent}
            errorStyles={errorStyles}
            errorScripts={errorScripts}
            template={
              <Template>
                <RenderFromTemplateContext />
              </Template>
            }
            templateStyles={templateStyles}
            templateScripts={templateScripts}
            notFound={notFoundComponent}
            notFoundStyles={notFoundStyles}
          />,
          childCacheNodeSeedData,
        ]
      }
    )
  )

  // Convert the parallel route map into an object after all promises have been resolved.
  let parallelRouteProps: { [key: string]: React.ReactNode } = {}
  let parallelRouteCacheNodeSeedData: {
    [key: string]: CacheNodeSeedData | null
  } = {}
  for (const parallelRoute of parallelRouteMap) {
    const [parallelRouteKey, parallelRouteProp, flightData] = parallelRoute
    parallelRouteProps[parallelRouteKey] = parallelRouteProp
    parallelRouteCacheNodeSeedData[parallelRouteKey] = flightData
  }

  const loadingData: LoadingModuleData = Loading
    ? [<Loading key="l" />, loadingStyles, loadingScripts]
    : null

  // When the segment does not have a layout or page we still have to add the layout router to ensure the path holds the loading component
  if (!MaybeComponent) {
    return [
      actualSegment,
      <Segment
        key={cacheNodeKey}
        isDynamicIO={experimental.dynamicIO}
        isStaticGeneration={isStaticGeneration}
        ready={getMetadataReady}
      >
        {layerAssets}
        {parallelRouteProps.children}
      </Segment>,
      parallelRouteCacheNodeSeedData,
      loadingData,
    ]
  }

  const Component = MaybeComponent

  // If force-dynamic is used and the current render supports postponing, we
  // replace it with a node that will postpone the render. This ensures that the
  // postpone is invoked during the react render phase and not during the next
  // render phase.
  // @TODO this does not actually do what it seems like it would or should do. The idea is that
  // if we are rendering in a force-dynamic mode and we can postpone we should only make the segments
  // that ask for force-dynamic to be dynamic, allowing other segments to still prerender. However
  // because this comes after the children traversal and the static generation store is mutated every segment
  // along the parent path of a force-dynamic segment will hit this condition effectively making the entire
  // render force-dynamic. We should refactor this function so that we can correctly track which segments
  // need to be dynamic
  if (
    workStore.isStaticGeneration &&
    workStore.forceDynamic &&
    experimental.isRoutePPREnabled
  ) {
    return [
      actualSegment,
      <Segment
        isDynamicIO={experimental.dynamicIO}
        key={cacheNodeKey}
        isStaticGeneration={isStaticGeneration}
        ready={getMetadataReady}
      >
        <Postpone
          reason='dynamic = "force-dynamic" was used'
          route={workStore.route}
        />
        {layerAssets}
      </Segment>,
      parallelRouteCacheNodeSeedData,
      loadingData,
    ]
  }

  const isClientComponent = isClientReference(layoutOrPageMod)

  if (
    process.env.NODE_ENV === 'development' &&
    'params' in parallelRouteProps
  ) {
    // @TODO consider making this an error and running the check in build as well
    console.error(
      `"params" is a reserved prop in Layouts and Pages and cannot be used as the name of a parallel route in ${segment}`
    )
  }

  if (isPage) {
    const PageComponent = Component
    // Assign searchParams to props if this is a page
    let pageElement: React.ReactNode
    if (isClientComponent) {
      if (isStaticGeneration) {
        const promiseOfParams = createPrerenderParamsForClientSegment(
          currentParams,
          workStore
        )
        const promiseOfSearchParams =
          createPrerenderSearchParamsForClientPage(workStore)
        pageElement = (
          <ClientPageRoot
            Component={PageComponent}
            searchParams={query}
            params={currentParams}
            promises={[promiseOfSearchParams, promiseOfParams]}
          />
        )
      } else {
        pageElement = (
          <ClientPageRoot
            Component={PageComponent}
            searchParams={query}
            params={currentParams}
          />
        )
      }
    } else {
      // If we are passing searchParams to a server component Page we need to track their usage in case
      // the current render mode tracks dynamic API usage.
      const params = createServerParamsForServerSegment(
        currentParams,
        workStore
      )
      const searchParams = createServerSearchParamsForServerPage(
        query,
        workStore
      )
      pageElement = (
        <PageComponent params={params} searchParams={searchParams} />
      )
    }
    return [
      actualSegment,
      <React.Fragment key={cacheNodeKey}>
        <MetadataOutlet ready={getMetadataReady} />
        <Segment
          isDynamicIO={experimental.dynamicIO}
          isStaticGeneration={isStaticGeneration}
          ready={getMetadataReady}
        >
          {pageElement}
          {layerAssets}
        </Segment>
      </React.Fragment>,
      parallelRouteCacheNodeSeedData,
      loadingData,
    ]
  } else {
    const SegmentComponent = Component

    const isRootLayoutWithChildrenSlotAndAtLeastOneMoreSlot =
      rootLayoutAtThisLevel &&
      'children' in parallelRoutes &&
      Object.keys(parallelRoutes).length > 1

    let segmentNode: React.ReactNode

    if (isClientComponent) {
      let clientSegment: React.ReactNode

      if (isStaticGeneration) {
        const promiseOfParams = createPrerenderParamsForClientSegment(
          currentParams,
          workStore
        )

        clientSegment = (
          <ClientSegmentRoot
            Component={SegmentComponent}
            slots={parallelRouteProps}
            params={currentParams}
            promise={promiseOfParams}
          />
        )
      } else {
        clientSegment = (
          <ClientSegmentRoot
            Component={SegmentComponent}
            slots={parallelRouteProps}
            params={currentParams}
          />
        )
      }

      if (isRootLayoutWithChildrenSlotAndAtLeastOneMoreSlot) {
        // TODO-APP: This is a hack to support unmatched parallel routes, which will throw `notFound()`.
        // This ensures that a `NotFoundBoundary` is available for when that happens,
        // but it's not ideal, as it needlessly invokes the `NotFound` component and renders the `RootLayout` twice.
        // We should instead look into handling the fallback behavior differently in development mode so that it doesn't
        // rely on the `NotFound` behavior.
        if (NotFound) {
          const notFoundParallelRouteProps = {
            children: (
              <>
                {notFoundStyles}
                <NotFound />
              </>
            ),
          }
          const notfoundClientSegment = (
            <ClientSegmentRoot
              Component={SegmentComponent}
              slots={notFoundParallelRouteProps}
              params={currentParams}
            />
          )

          segmentNode = (
            <Segment
              isDynamicIO={experimental.dynamicIO}
              isStaticGeneration={isStaticGeneration}
              ready={getMetadataReady}
            >
              <NotFoundBoundary
                notFound={
                  <>
                    {layerAssets}
                    {notfoundClientSegment}
                  </>
                }
              >
                {layerAssets}
                {clientSegment}
              </NotFoundBoundary>
            </Segment>
          )
        } else {
          segmentNode = (
            <Segment
              isDynamicIO={experimental.dynamicIO}
              isStaticGeneration={isStaticGeneration}
              ready={getMetadataReady}
            >
              <NotFoundBoundary>
                {layerAssets}
                {clientSegment}
              </NotFoundBoundary>
            </Segment>
          )
        }
      } else {
        segmentNode = (
          <Segment
            key={cacheNodeKey}
            isDynamicIO={experimental.dynamicIO}
            isStaticGeneration={isStaticGeneration}
            ready={getMetadataReady}
          >
            {layerAssets}
            {clientSegment}
          </Segment>
        )
      }
    } else {
      const params = createServerParamsForServerSegment(
        currentParams,
        workStore
      )

      let serverSegment = (
        <SegmentComponent {...parallelRouteProps} params={params} />
      )

      if (isRootLayoutWithChildrenSlotAndAtLeastOneMoreSlot) {
        // TODO-APP: This is a hack to support unmatched parallel routes, which will throw `notFound()`.
        // This ensures that a `NotFoundBoundary` is available for when that happens,
        // but it's not ideal, as it needlessly invokes the `NotFound` component and renders the `RootLayout` twice.
        // We should instead look into handling the fallback behavior differently in development mode so that it doesn't
        // rely on the `NotFound` behavior.
        segmentNode = (
          <Segment
            isDynamicIO={experimental.dynamicIO}
            isStaticGeneration={isStaticGeneration}
            ready={getMetadataReady}
          >
            <NotFoundBoundary
              notFound={
                NotFound ? (
                  <>
                    {layerAssets}
                    <SegmentComponent params={params}>
                      {notFoundStyles}
                      <NotFound />
                    </SegmentComponent>
                  </>
                ) : undefined
              }
            >
              {layerAssets}
              {serverSegment}
            </NotFoundBoundary>
          </Segment>
        )
      } else {
        segmentNode = (
          <Segment
            key={cacheNodeKey}
            isDynamicIO={experimental.dynamicIO}
            isStaticGeneration={isStaticGeneration}
            ready={getMetadataReady}
          >
            {layerAssets}
            {serverSegment}
          </Segment>
        )
      }
    }
    // For layouts we just render the component
    return [
      actualSegment,
      segmentNode,
      parallelRouteCacheNodeSeedData,
      loadingData,
    ]
  }
}

async function MetadataOutlet({
  ready,
}: {
  ready: () => Promise<void> & { status?: string; value?: unknown }
}) {
  const r = ready()
  // We can avoid a extra microtask by unwrapping the instrumented promise directly if available.
  if (r.status === 'rejected') {
    throw r.value
  } else if (r.status !== 'fulfilled') {
    await r
  }
  return null
}

async function Segment({
  isDynamicIO,
  isStaticGeneration,
  ready,
  children,
}: {
  isDynamicIO: boolean
  isStaticGeneration: boolean
  ready?: () => Promise<void>
  children: React.ReactNode
}) {
  if (isDynamicIO && isStaticGeneration && ready) {
    // During static generation we wait for metadata to complete before rendering segments.
    // This is slower but it allows us to ensure that metadata is finished before we start
    // rendering the segment which can synchronously abort the render in certain circumstances
    try {
      await ready()
    } catch {
      // we'll let the MetadataOutlet component render with the page error to let the right
      // error boundary catch this error
    }
  }
  return children
}
