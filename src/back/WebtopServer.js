#!/usr/bin/env node

'use strict'

const express = require('express')
const path = require('path')
const methodOverride = require('method-override')
const bodyParser = require('body-parser')
const errorHandler = require('errorhandler')
const Promise = require('bluebird')
const _ = require('lodash')
const opn = require('opn')
const parseColumns = require('parse-columns')
const execAsync = Promise.promisify(require('child_process').exec)

function getTransform (cols) {
  return (val, col) => {
    if (typeof cols[col] === 'function') return cols[col].apply(this, arguments)
    switch (cols[col]) {
      case 'number': val = Number(val)
    }
    return val
  }
}

const psTransform = getTransform(require('../psCols'))
const lsoiTransform = getTransform(require('../lsoiCols'))

class WebtopServer {
  constructor (opts) {
    this.opts = opts
    this.initApp()
  }

  initApp () {
    var app = this.app = express()

    app.use(methodOverride(null, {methods: ['GET', 'POST']}))
    app.use(bodyParser.json())
    app.use(bodyParser.urlencoded({
      extended: true
    }))
    if (this.opts.debug) app.use(errorHandler({
      dumpExceptions: true,
      showStack: true
    }))

    app.get('/api/ps', (req, res) => {
      this.ps().then(ps => { res.json(ps) }).done()
    })
    app.get('/api/lsoh', (req, res) => {
      this.lsoh().then(hs => { res.json(hs) }).done()
    })
    app.post('/api/kill', (req, res) => {
      if (!this.opts.debug) req.param('pids', '')
        .split(/\s*,\s*/)
        .forEach(pid => { process.kill(pid, req.param('signal')) })
      res.json(true)
    })
    app.use(express.static(path.resolve(__dirname, '..', '..', 'dist')))
  }

  listen () {
    var listener
    return new Promise(resolve => (
      listener = this.app.listen(this.opts.port, this.opts.hostname, resolve)
    )).then(() => listener)
  }

  main () {
    this.listen()
      .then(listener => listener.address())
      .then(bound => `http://${bound.address}:${bound.port}`)
      .tap(address => {
        console.error(`WebtopServer started: ${address}`)
        if (this.opts.open) {
          console.error("(opts.open = true, opening)")
          opn(address)
        }
      })
      .done()
  }

  _ps (args) { return this.execTable(`ps -Eeo ${args.join(',')}`, psTransform) }
  ps () {
    var cols = _(this.opts.psColumns).object().set('pid', true).value()
    var psCalls = []
    if ('args' in cols && 'comm' in cols) {
      psCalls.push(['pid', 'args'])
      delete cols.args
    }
    psCalls.push(_.keys(cols))
    return Promise
      .all(psCalls.map(args => this._ps(args)))
      .then(ress => _(ress)
        .flatten()
        .groupBy('PID')
        .mapValues(pidGroup => {
          var p = _.merge.apply(null, [{}].concat(pidGroup))
          if (this.opts.debug && 'ARGS' in p) p.ARGS = ['COMM' in p // replace potentially insecure environment variables and cmdline params in p.ARGS
            ? p.COMM.replace(/^\((.*)\)$/, '$1')
            : p.ARGS.replace(/\s.*$/, '')
          ]
            .concat(this.constructor.FAKE_ARGS.filter(() => Math.random() < .1))
            .join(' ')
          return p
        })
        .values()
        .value())
  }

  lsoi () { return this.execTable('lsof -i -P', lsoiTransform) }
  lsoh () { return this.lsoi() }

  execTable (cmd, transform) {
    return execAsync(cmd, {maxBuffer: this.opts.maxBuffer})
      .then(stdout => parseColumns(stdout, {transform: transform}))
  }
}
WebtopServer.FAKE_ARGS = ['-x', '-y', '--foo', '--bar=2', 'BAZ=123', '__BEEP_BOOP=80085']

module.exports = WebtopServer

if (require.main === module) new WebtopServer(require('../../config')).main()
