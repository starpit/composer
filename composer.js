/*
 * Copyright 2017-2018 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

// composer module

const fs = require('fs')
const os = require('os')
const path = require('path')
const util = require('util')
const openwhisk = require('openwhisk')

class ComposerError extends Error {
    constructor(message, argument) {
        super(message + (typeof argument !== 'undefined' ? '\nArgument: ' + util.inspect(argument) : ''))
    }
}

function validate(options) {
    if (typeof options === 'undefined') return
    if (typeof options !== 'object' || Array.isArray(options) || options === null) throw new ComposerError('Invalid options', options)
    options = JSON.stringify(options)
    if (options === '{}') return
    return JSON.parse(options)
}

let wsk

class Composition {
    constructor(composition, actions = []) {
        Object.keys(composition).forEach(key => {
            if (composition[key] instanceof Composition) {
                // TODO: check for duplicate entries
                actions.push(...composition[key].actions || [])
                composition[key] = composition[key].composition
            }
        })
        if (Array.isArray(composition)) {
            composition = composition.reduce((composition, component) => {
                if (Array.isArray(component)) composition.push(...component); else composition.push(component)
                return composition
            }, [])
            if (composition.length === 1) composition = composition[0]
        }
        if (actions.length > 0) this.actions = actions
        this.composition = composition
    }

    named(name) {
        if (arguments.length > 1) throw new ComposerError('Too many arguments')
        if (typeof name !== 'string') throw new ComposerError('Invalid argument', name)
        const actions = []
        if (this.actions && this.actions.findIndex(action => action.name === name) !== -1) throw new ComposerError('Duplicate action name', name)
        const code = `const __eval__ = main => eval(main)\nconst main = (${conductor})(${JSON.stringify(this.composition, null, 4)})\n`
        actions.push(...this.actions || [], { name, action: { exec: { kind: 'nodejs:default', code }, annotations: [{ key: 'conductor', value: this.composition }] } })
        return new Composition({ type: 'action', name }, actions)
    }

    deploy() {
        if (arguments.length > 0) throw new ComposerError('Too many arguments')
        if (this.composition.type !== 'action') throw new ComposerError('Cannot deploy anonymous composition')
        let i = 0
        return this.actions.reduce((promise, action) =>
            promise.then(() => wsk.actions.delete(action)).catch(() => { }).then(() => wsk.actions.update(action).then(() => i++, err => console.error(err))), Promise.resolve()).then(() => i)
    }
}

class Composer {
    constructor(options = {}) {
        // try to extract apihost and key from wskprops
        let apihost
        let api_key

        try {
            const wskpropsPath = process.env.WSK_CONFIG_FILE || path.join(os.homedir(), '.wskprops')
            const lines = fs.readFileSync(wskpropsPath, { encoding: 'utf8' }).split('\n')

            for (let line of lines) {
                let parts = line.trim().split('=')
                if (parts.length === 2) {
                    if (parts[0] === 'APIHOST') {
                        apihost = parts[1]
                    } else if (parts[0] === 'AUTH') {
                        api_key = parts[1]
                    }
                }
            }
        } catch (error) { }

        this.wsk = wsk = openwhisk(Object.assign({ apihost, api_key }, options))
        this.seq = this.sequence
    }

    task(obj) {
        if (arguments.length > 1) throw new ComposerError('Too many arguments')
        if (obj == null) return this.seq()
        if (obj instanceof Composition) return obj
        if (typeof obj === 'function') return this.function(obj)
        if (typeof obj === 'string') return this.action(obj)
        throw new ComposerError('Invalid argument', obj)
    }

    sequence() { // varargs, no options
        return new Composition(Array.prototype.map.call(arguments, obj => this.task(obj), this))
    }

    if(test, consequent, alternate, options) {
        if (arguments.length > 4) throw new ComposerError('Too many arguments')
        return new Composition({ type: 'if', test: this.task(test), consequent: this.task(consequent), alternate: this.task(alternate), options: validate(options) })
    }

    while(test, body, options) {
        if (arguments.length > 3) throw new ComposerError('Too many arguments')
        return new Composition({ type: 'while', test: this.task(test), body: this.task(body), options: validate(options) })
    }

    try(body, handler, options) {
        if (arguments.length > 3) throw new ComposerError('Too many arguments')
        return new Composition({ type: 'try', body: this.task(body), handler: this.task(handler), options: validate(options) })
    }

    finally(body, finalizer, options) {
        if (arguments.length > 3) throw new ComposerError('Too many arguments')
        return new Composition({ type: 'finally', body: this.task(body), finalizer: this.task(finalizer), options: validate(options) })
    }

    let(declarations) { // varargs, no options
        if (typeof declarations !== 'object' || declarations === null) throw new ComposerError('Invalid argument', declarations)
        return new Composition({ type: 'let', declarations, body: this.seq(...Array.prototype.slice.call(arguments, 1)) })
    }

    literal(value, options) {
        if (arguments.length > 2) throw new ComposerError('Too many arguments')
        if (typeof value === 'function') throw new ComposerError('Invalid argument', value)
        return new Composition({ type: 'literal', value: typeof value === 'undefined' ? {} : value, options: validate(options) })
    }

    function(exec, options) {
        if (arguments.length > 2) throw new ComposerError('Too many arguments')
        if (typeof exec === 'function') {
            exec = `${exec}`
            if (exec.indexOf('[native code]') !== -1) throw new ComposerError('Cannot capture native function', exec)
        }
        if (typeof exec === 'string') {
            exec = { kind: 'nodejs:default', exec }
        }
        if (typeof exec !== 'object' || exec === null) throw new ComposerError('Invalid argument', exec)
        return new Composition({ type: 'function', exec, options: validate(options) })
    }

    action(name, options) {
        if (arguments.length > 2) throw new ComposerError('Too many arguments')
        if (typeof name !== 'string') throw new ComposerError('Invalid argument', name)
        let exec
        if (options && Array.isArray(options.sequence)) { // native sequence
            const components = options.sequence.map(a => a.indexOf('/') == -1 ? `/_/${a}` : a)
            exec = { kind: 'sequence', components }
            delete options.sequence
        }
        if (options && typeof options.filename === 'string') { // read action code from file
            options.action = fs.readFileSync(options.filename, { encoding: 'utf8' })
            delete options.filename
        }
        if (options && typeof options.action === 'function') {
            options.action = `${options.action}`
            if (options.action.indexOf('[native code]') !== -1) throw new ComposerError('Cannot capture native function', options.action)
        }
        if (options && typeof options.action === 'string') {
            options.action = { kind: 'nodejs:default', code: options.action }
        }
        if (options && typeof options.action === 'object' && options.action !== null) {
            exec = options.action
            delete options.action
        }
        return new Composition({ type: 'action', name, options: validate(options) }, exec ? [{ name, action: { exec } }] : [])
    }

    retain(body, options) {
        if (arguments.length > 2) throw new ComposerError('Too many arguments')
        if (options && typeof options.filter === 'function') {
            // return { params: filter(params), result: body(params) }
            const filter = options.filter
            delete options.filter
            options.field = 'result'
            return this.seq(this.retain(filter), this.retain(this.finally(this.function(({ params }) => params, { helper: 'retain_3' }), body), options))
        }
        if (options && typeof options.catch === 'boolean' && options.catch) {
            // return { params, result: body(params) } even if result is an error
            delete options.catch
            return this.seq(
                this.retain(this.finally(body, this.function(result => ({ result }), { helper: 'retain_1' })), options),
                this.function(({ params, result }) => ({ params, result: result.result }), { helper: 'retain_2' }))
        }
        if (options && typeof options.field !== 'undefined' && typeof options.field !== 'string') throw new ComposerError('Invalid options', options)
        // return new Composition({ params, result: body(params) } if no error, otherwise body(params)
        return new Composition({ type: 'retain', body: this.task(body), options: validate(options) })
    }

    repeat(count) { // varargs, no options
        if (typeof count !== 'number') throw new ComposerError('Invalid argument', count)
        return this.let({ count }, this.while(this.function(() => count-- > 0, { helper: 'repeat_1' }), this.seq(...Array.prototype.slice.call(arguments, 1))))
    }

    retry(count) { // varargs, no options
        if (typeof count !== 'number') throw new ComposerError('Invalid argument', count)
        const attempt = this.retain(this.seq(...Array.prototype.slice.call(arguments, 1)), { catch: true })
        return this.let({ count },
            attempt,
            this.while(
                this.function(({ result }) => typeof result.error !== 'undefined' && count-- > 0, { helper: 'retry_1' }),
                this.finally(this.function(({ params }) => params, { helper: 'retry_2' }), attempt)),
            this.function(({ result }) => result, { helper: 'retry_3' }))
    }
}

module.exports = options => new Composer(options)

// conductor action

function conductor(composition) {
    function chain(front, back) {
        front.slice(-1)[0].next = 1
        front.push(...back)
        return front
    }

    function compile(json, path = '') {
        if (Array.isArray(json)) {
            if (json.length === 0) return [{ type: 'pass', path }]
            return json.map((json, index) => compile(json, path + '[' + index + ']')).reduce(chain)
        }
        const options = json.options || {}
        switch (json.type) {
            case 'action':
                return [{ type: 'action', name: json.name, path }]
            case 'function':
                return [{ type: 'function', exec: json.exec, path }]
            case 'literal':
                return [{ type: 'literal', value: json.value, path }]
            case 'finally':
                var body = compile(json.body, path + '.body')
                const finalizer = compile(json.finalizer, path + '.finalizer')
                var fsm = [[{ type: 'try', path }], body, [{ type: 'exit', path }], finalizer].reduce(chain)
                fsm[0].catch = fsm.length - finalizer.length
                return fsm
            case 'let':
                var body = compile(json.body, path + '.body')
                return [[{ type: 'let', let: json.declarations, path }], body, [{ type: 'exit', path }]].reduce(chain)
            case 'retain':
                var body = compile(json.body, path + '.body')
                var fsm = [[{ type: 'push', path }], body, [{ type: 'pop', collect: true, path }]].reduce(chain)
                if (options.field) fsm[0].field = options.field
                return fsm
            case 'try':
                var body = compile(json.body, path + '.body')
                const handler = chain(compile(json.handler, path + '.handler'), [{ type: 'pass', path }])
                var fsm = [[{ type: 'try', path }], body].reduce(chain)
                fsm[0].catch = fsm.length
                fsm.slice(-1)[0].next = handler.length
                fsm.push(...handler)
                return fsm
            case 'if':
                var consequent = compile(json.consequent, path + '.consequent')
                var alternate = chain(compile(json.alternate, path + '.alternate'), [{ type: 'pass', path }])
                if (!options.nosave) consequent = chain([{ type: 'pop', path }], consequent)
                if (!options.nosave) alternate = chain([{ type: 'pop', path }], alternate)
                var fsm = chain(compile(json.test, path + '.test'), [{ type: 'choice', then: 1, else: consequent.length + 1, path }])
                if (!options.nosave) fsm = chain([{ type: 'push', path }], fsm)
                consequent.slice(-1)[0].next = alternate.length
                fsm.push(...consequent)
                fsm.push(...alternate)
                return fsm
            case 'while':
                var consequent = compile(json.body, path + '.body')
                var alternate = [{ type: 'pass', path }]
                if (!options.nosave) consequent = chain([{ type: 'pop', path }], consequent)
                if (!options.nosave) alternate = chain([{ type: 'pop', path }], alternate)
                var fsm = chain(compile(json.test, path + ':test'), [{ type: 'choice', then: 1, else: consequent.length + 1, path }])
                if (!options.nosave) fsm = chain([{ type: 'push', path }], fsm)
                consequent.slice(-1)[0].next = 1 - fsm.length - consequent.length
                fsm.push(...consequent)
                fsm.push(...alternate)
                return fsm
        }
    }

    const fsm = compile(composition)

    const isObject = obj => typeof obj === 'object' && obj !== null && !Array.isArray(obj)

    // encode error object
    const encodeError = error => ({
        code: typeof error.code === 'number' && error.code || 500,
        error: (typeof error.error === 'string' && error.error) || error.message || (typeof error === 'string' && error) || 'An internal error occurred'
    })

    // error status codes
    const badRequest = error => Promise.reject({ code: 400, error })
    const internalError = error => Promise.reject(encodeError(error))

    return params => Promise.resolve().then(() => invoke(params)).catch(internalError)

    // do invocation
    function invoke(params) {
        // initial state and stack
        let state = 0
        let stack = []

        // restore state and stack when resuming
        if (typeof params.$resume !== 'undefined') {
            if (!isObject(params.$resume)) return badRequest('The type of optional $resume parameter must be object')
            state = params.$resume.state
            stack = params.$resume.stack
            if (typeof state !== 'undefined' && typeof state !== 'number') return badRequest('The type of optional $resume.state parameter must be number')
            if (!Array.isArray(stack)) return badRequest('The type of $resume.stack must be an array')
            delete params.$resume
            inspect() // handle error objects when resuming
        }

        // wrap params if not a dictionary, branch to error handler if error
        function inspect() {
            if (!isObject(params)) params = { value: params }
            if (typeof params.error !== 'undefined') {
                params = { error: params.error } // discard all fields but the error field
                state = undefined // abort unless there is a handler in the stack
                while (stack.length > 0) {
                    if (typeof (state = stack.shift().catch) === 'number') break
                }
            }
        }

        // run function f on current stack
        function run(f) {
            // update value of topmost matching symbol on stack if any
            function set(symbol, value) {
                const element = stack.find(element => typeof element.let !== 'undefined' && typeof element.let[symbol] !== 'undefined')
                if (typeof element !== 'undefined') element.let[symbol] = JSON.parse(JSON.stringify(value))
            }

            // collapse stack for invocation
            const env = stack.reduceRight((acc, cur) => typeof cur.let === 'object' ? Object.assign(acc, cur.let) : acc, {})
            let main = '(function main(){try{'
            for (const name in env) main += `var ${name}=arguments[1]['${name}'];`
            main += `return eval((${f}))(arguments[0])}finally{`
            for (const name in env) main += `arguments[1]['${name}']=${name};`
            main += '}})'
            try {
                return __eval__(main)(params, env)
            } finally {
                for (const name in env) set(name, env[name])
            }
        }

        while (true) {
            // final state, return composition result
            if (typeof state === 'undefined') {
                console.log(`Entering final state`)
                console.log(JSON.stringify(params))
                if (params.error) return params; else return { params }
            }

            // process one state
            console.log(`Entering ${state}`)

            const json = fsm[state] // json definition for current state
            const current = state
            state = typeof json.next === 'undefined' ? undefined : current + json.next // default next state
            console.log(json)
            switch (json.type) {
                case 'choice':
                    state = current + (params.value ? json.then : json.else)
                    break
                case 'try':
                    stack.unshift({ catch: current + json.catch })
                    break
                case 'let':
                    stack.unshift({ let: JSON.parse(JSON.stringify(json.let)) })
                    break
                case 'exit':
                    if (stack.length === 0) return internalError(`State ${current} attempted to pop from an empty stack`)
                    stack.shift()
                    break
                case 'push':
                    stack.unshift(JSON.parse(JSON.stringify({ params: json.field ? params[json.field] : params })))
                    break
                case 'pop':
                    if (stack.length === 0) return internalError(`State ${current} attempted to pop from an empty stack`)
                    params = json.collect ? { params: stack.shift().params, result: params } : stack.shift().params
                    break
                case 'action':
                    return { action: json.name, params, state: { $resume: { state, stack } } } // invoke continuation
                    break
                case 'literal':
                    params = JSON.parse(JSON.stringify(json.value))
                    inspect()
                    break
                case 'function':
                    let result
                    try {
                        result = run(json.exec.exec)
                    } catch (error) {
                        console.error(error)
                        result = { error: `An exception was caught at state ${current} (see log for details)` }
                    }
                    if (typeof result === 'function') result = { error: `State ${current} evaluated to a function` }
                    // if a function has only side effects and no return value, return params
                    params = JSON.parse(JSON.stringify(typeof result === 'undefined' ? params : result))
                    inspect()
                    break
                case 'pass':
                    inspect()
                    break
                default:
                    return internalError(`State ${current} has an unknown type`)
            }
        }
    }
}
