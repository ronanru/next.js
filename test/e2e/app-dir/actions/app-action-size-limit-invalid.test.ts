import { createNextDescribe } from 'e2e-utils'
import { retry } from 'next-test-utils'
import { accountForOverhead } from './account-for-overhead'

const CONFIG_ERROR =
  'Server Actions Size Limit must be a valid number or filesize format larger than 1MB'

createNextDescribe(
  'app-dir action size limit invalid config',
  {
    files: __dirname,
    skipDeployment: true,
    skipStart: true,
    dependencies: {
      react: 'latest',
      'react-dom': 'latest',
      'server-only': 'latest',
    },
  },
  ({ next, isNextStart, isNextDeploy }) => {
    if (!isNextStart) {
      it('skip test for development mode', () => {})
      return
    }

    it('should error if serverActions.bodySizeLimit config is a negative number', async function () {
      await next.patchFile(
        'next.config.js',
        `
    module.exports = {
      experimental: {
        serverActions: { bodySizeLimit: -3000 }
      },
    }
    `
      )
      try {
        await next.start()
      } catch {}
      expect(next.cliOutput).toContain(CONFIG_ERROR)
    })

    it('should error if serverActions.bodySizeLimit config is invalid', async function () {
      await next.patchFile(
        'next.config.js',
        `
      module.exports = {
        experimental: {
          serverActions: { bodySizeLimit: 'testmb' }
        },
      }
      `
      )
      try {
        await next.start()
      } catch {}
      expect(next.cliOutput).toContain(CONFIG_ERROR)
    })

    it('should error if serverActions.bodySizeLimit config is a negative size', async function () {
      await next.patchFile(
        'next.config.js',
        `
      module.exports = {
        experimental: {
          serverActions: { bodySizeLimit: '-3000mb' }
        },
      }
      `
      )
      try {
        await next.start()
      } catch {}
      expect(next.cliOutput).toContain(CONFIG_ERROR)
    })

    describe.each<{
      runtime: string
      suffix?: string
    }>([
      {
        runtime: 'edge',
        suffix: '/edge',
      },
      {
        runtime: 'node',
      },
    ])('$runtime', ({ suffix = '' }) => {
      if (isNextDeploy) return

      const logs: string[] = []
      const onLog = (log: string) => {
        logs.push(log.trim())
      }

      beforeEach(async () => {
        await next.stop()
      })

      beforeAll(() => {
        next.on('stdout', onLog)
        next.on('stderr', onLog)
      })

      it('should respect the size set in serverActions.bodySizeLimit', async function () {
        await next.patchFile(
          'next.config.js',
          `
      module.exports = {
        experimental: {
          serverActions: { bodySizeLimit: '1.5mb' }
        },
      }
      `
        )

        await next.start()
        logs.length = 0

        const browser = await next.browser('/file' + suffix, {})
        await browser.elementByCss('#size-1mb').click()

        await retry(() => {
          expect(logs).toContainEqual(`size = ${accountForOverhead(1)}`)
        })

        await browser.elementByCss('#size-2mb').click()

        await retry(() => {
          expect(logs).toContainEqual(
            expect.stringContaining('Body exceeded 1.5mb limit')
          )
          expect(logs).toContainEqual(
            expect.stringContaining(
              'To configure the body size limit for Server Actions, see'
            )
          )
        })
      })

      it('should respect the size set in serverActions.bodySizeLimit when submitting form', async function () {
        await next.patchFile(
          'next.config.js',
          `
      module.exports = {
        experimental: {
          serverActions: { bodySizeLimit: '2mb' }
        },
      }
      `
        )

        await next.start()
        logs.length = 0

        const browser = await next.browser('/form' + suffix)
        await browser.elementByCss('#size-1mb').click()

        await retry(() => {
          expect(logs).toContainEqual(`size = ${accountForOverhead(1)}`)
        })

        await browser.elementByCss('#size-2mb').click()

        await retry(() => {
          expect(logs).toContainEqual(`size = ${accountForOverhead(2)}`)
        })
      })
    })
  }
)
