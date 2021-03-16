// 生成页面的屏幕截图或 pdf
// 自动化提交表单、模拟键盘输入、自动化单元测试等
// 网站性能分析：可以抓取并跟踪网站的执行时间轴，帮助分析效率问题
// 抓取网页内容，也就是我们常说的爬虫

// 之前的promise.all等都是全部返回才结束，而这个可以控制每次返回的数量
// 进而可以减少同时并发太多
// https://www.npmjs.com/package/promise-limit
const promiseLimit = require('promise-limit')
// 终于找到根文件了
const puppeteer = require('puppeteer')

const waitForRender = function (options) {
  options = options || {}

  return new Promise((resolve, reject) => {
    // Render when an event fires on the document.
    if (options.renderAfterDocumentEvent) {
      if (window['__PRERENDER_STATUS'] && window['__PRERENDER_STATUS'].__DOCUMENT_EVENT_RESOLVED) resolve()
      // 这里就是指定页面什么事件触发渲染，因为用document绑定的事件，因此像load事件就不行了。。。但也很少使用load事件
      document.addEventListener(options.renderAfterDocumentEvent, () => resolve())

    // Render after a certain number of milliseconds.
    } else if (options.renderAfterTime) {
      setTimeout(() => resolve(), options.renderAfterTime)

    // Default: Render immediately after page content loads.
    } else {
      resolve()
    }
  })
}

class PuppeteerRenderer {
  constructor (rendererOptions) {
    this._puppeteer = null
    this._rendererOptions = rendererOptions || {}

    if (this._rendererOptions.maxConcurrentRoutes == null) this._rendererOptions.maxConcurrentRoutes = 0

    // 如果没有配置，则默认添加__PRERENDER_INJECTED属性
    if (this._rendererOptions.inject && !this._rendererOptions.injectProperty) {
      this._rendererOptions.injectProperty = '__PRERENDER_INJECTED'
    }
  }

  async initialize () {
    try {
      // 判断平台
      // Workaround for Linux SUID Sandbox issues.
      if (process.platform === 'linux') {
        if (!this._rendererOptions.args) this._rendererOptions.args = []

        if (this._rendererOptions.args.indexOf('--no-sandbox') === -1) {
          this._rendererOptions.args.push('--no-sandbox')
          this._rendererOptions.args.push('--disable-setuid-sandbox')
        }
      }

      // 启动浏览器
      this._puppeteer = await puppeteer.launch(this._rendererOptions)
    } catch (e) {
      console.error(e)
      console.error('[Prerenderer - PuppeteerRenderer] Unable to start Puppeteer')
      // Re-throw the error so it can be handled further up the chain. Good idea or not?
      throw e
    }

    return this._puppeteer
  }

  async handleRequestInterception (page, baseURL) {
    // 其实就是激活请求拦截，激活后就可以以同步代码形式来操作请求了，是暂停还是取消等，都可以控制了
    // https://pptr.dev/#?product=Puppeteer&version=v7.1.0&show=api-pagesetrequestinterceptionvalue
    await page.setRequestInterception(true)

    page.on('request', req => {
      // Skip third party requests if needed.
      if (this._rendererOptions.skipThirdPartyRequests) {
        // 有白名单，怎么还需要判断这里？第三方的请求，肯定不满足条件
        if (!req.url().startsWith(baseURL)) {
          req.abort()
          return
        }
      }

      req.continue()
    })
  }

  async renderRoutes (routes, Prerenderer) {
    const rootOptions = Prerenderer.getOptions()
    const options = this._rendererOptions

    // 限流控制渲染的数量
    const limiter = promiseLimit(this._rendererOptions.maxConcurrentRoutes)

    const pagePromises = Promise.all(
      routes.map(
        (route, index) => limiter(
          async () => {
            // 开启一个页面
            const page = await this._puppeteer.newPage()

            // 注册console
            if (options.consoleHandler) {
              page.on('console', message => options.consoleHandler(route, message))
            }

            // 是否需要像window上注入一些全局属性，值就是JSON.stringify(options.inject)
            if (options.inject) {
              // https://pptr.dev/#?product=Puppeteer&version=v7.1.0&show=api-pageevaluateonnewdocumentpagefunction-args
              // 切换新页签或其他情况下会触发，而且触发的时机是after the document was created but before any of its scripts were run
              await page.evaluateOnNewDocument(`(function () { window['${options.injectProperty}'] = ${JSON.stringify(options.inject)}; })();`)
            }

            // 默认是localhost
            const baseURL = `http://localhost:${rootOptions.server.port}`

            // Allow setting viewport widths and such.
            if (options.viewport) await page.setViewport(options.viewport)

            // page就是当前浏览器tab的实例，然后访问首页
            await this.handleRequestInterception(page, baseURL)

            // 防止document的事件在我们添加的事件之前触发。。
            // Hack just in-case the document event fires before our main listener is added.
            if (options.renderAfterDocumentEvent) {
              page.evaluateOnNewDocument(function (options) {
                window['__PRERENDER_STATUS'] = {}
                document.addEventListener(options.renderAfterDocumentEvent, () => {
                  window['__PRERENDER_STATUS'].__DOCUMENT_EVENT_RESOLVED = true
                })
              }, this._rendererOptions)
            }
            
            // waitUntil代表什么时候才认为导航加载成功。其实就是一个标准，如果发现满足这些条件了，我就认为你页面加载好了
            // load: window.onload事件被触发时候完成导航,某些情况下它根本不会发生。
            // domcontentloaded: Domcontentloaded事件触发时候认为导航成功
            // networkidle0: 在 500ms 内没有网络连接时就算成功(全部的request结束),才认为导航结束
            // networkidle2: 500ms 内有不超过 2 个网络连接时就算成功(还有两个以下的request),就认为导航完成。

            const navigationOptions = (options.navigationOptions) ? { waituntil: 'networkidle0', ...options.navigationOptions } : { waituntil: 'networkidle0' };
            await page.goto(`${baseURL}${route}`, navigationOptions);

            // 还可以指定一些具体的某些元素是否存在
            // Wait for some specific element exists
            const { renderAfterElementExists } = this._rendererOptions
            if (renderAfterElementExists && typeof renderAfterElementExists === 'string') {
              // 暂时没说是靠哪种方式拿到了，但对于chrome，此事应该很简单
              // https://pptr.dev/#?product=Puppeteer&version=v7.1.0&show=api-pagewaitforselectorselector-options
              await page.waitForSelector(renderAfterElementExists)
            }
            // Once this completes, it's safe to capture the page contents.
            await page.evaluate(waitForRender, this._rendererOptions)

            const result = {
              originalRoute: route,
              route: await page.evaluate('window.location.pathname'),
              html: await page.content() // 这就拿到了最终的html
            }

            await page.close()
            return result
          }
        )
      )
    )

    return pagePromises
  }

  destroy () {
    if(this._puppeteer) {
      try {
        this._puppeteer.close()
      } catch (e) {
        console.error(e)
        console.error('[Prerenderer - PuppeteerRenderer] Unable to close Puppeteer')
		  
        throw e
      }
    }
  }
}

module.exports = PuppeteerRenderer
