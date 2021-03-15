const express = require('express')
const proxy = require('http-proxy-middleware')
const path = require('path')

class Server {
  constructor (Prerenderer) {
    this._prerenderer = Prerenderer
    this._options = Prerenderer.getOptions()
    this._expressServer = express()
    this._nativeServer = null
  }

  initialize () {
    const server = this._expressServer

    // 支持自定义服务器
    if (this._options.server && this._options.server.before) {
      this._options.server.before(server)
    }

    this._prerenderer.modifyServer(this, 'pre-static')

    // 设置静态文件服务器
    server.get('*', express.static(this._options.staticDir, {
      // 其实就是如何处理逗号.
      // https://expressjs.com/zh-cn/api.html#dotfiles
      // “allow” - No special treatment for dotfiles.
      // “deny” - Deny a request for a dotfile, respond with 403, then call next().
      // “ignore” - Act as if the dotfile does not exist, respond with 404, then call next().
      dotfiles: 'allow'
    }))

    this._prerenderer.modifyServer(this, 'post-static')

    this._prerenderer.modifyServer(this, 'pre-fallback')

    // 用户是否传入了自己的proxy配置
    if (this._options.server && this._options.server.proxy) {
      for (let proxyPath of Object.keys(this._options.server.proxy)) {
        server.use(proxyPath, proxy(this._options.server.proxy[proxyPath]))
      }
    }

    server.get('*', (req, res) => {
      // 如果路径不存在，这里返回index.html
      res.sendFile(this._options.indexPath ? this._options.indexPath : path.join(this._options.staticDir, 'index.html'))
    })

    this._prerenderer.modifyServer(this, 'post-fallback')

    return new Promise((resolve, reject) => {
      this._nativeServer = server.listen(this._options.server.port, () => {
        resolve()
      })
    })
  }

  destroy () {
    this._nativeServer.close()
  }
}

module.exports = Server
