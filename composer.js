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
        const code = `${__init__}\n${__eval__}${main}\nconst __composition__ = __init__(${JSON.stringify(this.composition, null, 4)})\n`
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
        return new Composition({ type: 'let', declarations: JSON.parse(JSON.stringify(declarations)), body: this.seq(...Array.prototype.slice.call(arguments, 1)) })
    }

    literal(value, options) {
        if (arguments.length > 2) throw new ComposerError('Too many arguments')
        if (typeof value === 'function') throw new ComposerError('Invalid argument', value)
        return new Composition({ type: 'literal', value: typeof value === 'undefined' ? {} : JSON.parse(JSON.stringify(value)), options: validate(options) })
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

function __init__(composition) {
    class FSM {
        constructor(exit) {
            this.states = [exit]
        }

        last() {
            return this.states[this.states.length - 1]
        }
    }

    function chain(front, back) {
        if (!(front instanceof FSM)) front = new FSM(front)
        if (!(back instanceof FSM)) back = new FSM(back)
        front.last().next = back.states[0]
        front.states.push(...back.states)
        return front
    }

    function compile(json, path = '') {
        if (Array.isArray(json)) {
            if (json.length === 0) return new FSM({ type: 'pass', path })
            return json.map((json, index) => compile(json, path + ':' + index)).reduce(chain)
        }
        const options = json.options || {}
        switch (json.type) {
            case 'action':
                return new FSM({ type: json.type, name: json.name, path })
            case 'function':
                return new FSM({ type: json.type, exec: json.exec, path })
            case 'literal':
                return new FSM({ type: json.type, value: json.value, path })
            case 'finally':
                var body = compile(json.body, path + ':1')
                const finalizer = compile(json.finalizer, path + ':2')
                return [{ type: 'try', catch: finalizer.states[0], path }, body, { type: 'exit', path }, finalizer].reduce(chain)
            case 'let':
                var body = compile(json.body, path + ':1')
                return [{ type: 'let', let: json.declarations, path }, body, { type: 'exit', path }].reduce(chain)
            case 'retain':
                var body = compile(json.body, path + ':1')
                var fsm = [{ type: 'push', path }, body, { type: 'pop', collect: true, path }].reduce(chain)
                if (options.field) fsm.states[0].field = options.field
                return fsm
            case 'try':
                var body = compile(json.body, path + ':1')
                const handler = chain(compile(json.handler, path + ':2'),{ type: 'pass', path })
                var fsm = [{ type: 'try', catch: handler.states[0], path }, body].reduce(chain)
                fsm.last().next = handler.last()
                fsm.states.push(...handler.states)
                return fsm
            case 'if':
                var consequent = compile(json.consequent, path + ':2')
                var alternate = chain(compile(json.alternate, path + ':3'), { type: 'pass', path })
                if (!options.nosave) consequent = chain({ type: 'pop', path }, consequent)
                if (!options.nosave) alternate = chain({ type: 'pop', path }, alternate)
                var fsm = chain(compile(json.test, path + ':1'), { type: 'choice', then: consequent.states[0], else: alternate.states[0], path })
                if (!options.nosave) fsm = chain({ type: 'push', path }, fsm)
                consequent.last().next = alternate.last()
                fsm.states.push(...consequent.states)
                fsm.states.push(...alternate.states)
                return fsm
            case 'while':
                var consequent = compile(json.body, path + ':2')
                var alternate = new FSM({ type: 'pass', path })
                if (!options.nosave) consequent = chain({ type: 'pop', path }, consequent)
                if (!options.nosave) alternate = chain({ type: 'pop', path }, alternate)
                var fsm = chain(compile(json.test, path + ':1'), { type: 'choice', then: consequent.states[0], else: alternate.states[0], path })
                if (!options.nosave) fsm = chain({ type: 'push', path }, fsm)
                consequent.last().next = fsm.states[0]
                fsm.states.push(...consequent.states)
                fsm.states.push(...alternate.states)
                return fsm
        }
    }

    const fsm = compile(composition)

    fsm.states.forEach(state => {
        Object.keys(state).forEach(key => {
            if (state[key].type) {
                state[key] = fsm.states.indexOf(state[key])
            }
        })
    })

    return fsm
}

function __eval__(main) { return eval(main) }

function main(params) {
    const isObject = obj => typeof obj === 'object' && obj !== null && !Array.isArray(obj)

    // encode error object
    const encodeError = error => ({
        code: typeof error.code === 'number' && error.code || 500,
        error: (typeof error.error === 'string' && error.error) || error.message || (typeof error === 'string' && error) || 'An internal error occurred'
    })

    // error status codes
    const badRequest = error => Promise.reject({ code: 400, error })
    const internalError = error => Promise.reject(encodeError(error))

    // catch all
    return Promise.resolve().then(() => invoke(params)).catch(internalError)

    // do invocation
    function invoke(params) {
        // initial state and stack
        let state = 0
        let stack = []

        // check parameters
        //        if (typeof __composition__.entry !== 'string') return badRequest('The composition has no entry field of type string')
        //        if (!isObject(__composition__.states)) return badRequest('The composition has no states field of type object')
        //        if (typeof __composition__.exit !== 'string') return badRequest('The composition has no exit field of type string')

        // restore state and stack when resuming
        if (typeof params.$resume !== 'undefined') {
            if (!isObject(params.$resume)) return badRequest('The type of optional $resume parameter must be object')
            state = params.$resume.state
            stack = params.$resume.stack
            //            if (typeof state !== 'undefined' && typeof state !== 'string') return badRequest('The type of optional $resume.state parameter must be string')
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

            if (!isObject(__composition__.states[state])) return badRequest(`State ${state} definition is missing`)
            const json = __composition__.states[state] // json definition for current state
            const current = state // current state for error messages
            //      if (json.type !== 'choice' && typeof json.next !== 'string' && state !== __composition__.exit) return badRequest(`State ${state} has no next field`)
            state = json.next // default next state
            console.log(json)
            switch (json.type) {
                case 'choice':
                    //                    if (typeof json.then !== 'string') return badRequest(`State ${current} has no then field`)
                    //                    if (typeof json.else !== 'string') return badRequest(`State ${current} has no else field`)
                    state = params.value === true ? json.then : json.else
                    break
                case 'try':
                    stack.unshift({ catch: json.catch })
                    break
                case 'let':
                    stack.unshift({ let: json.let })
                    break
                case 'exit':
                    if (stack.length === 0) return badRequest(`State ${current} attempted to pop from an empty stack`)
                    stack.shift()
                    break
                case 'push':
                    if (typeof json.field !== 'undefined' && typeof json.field !== 'string') return badRequest(`State ${current} is invalid`)
                    stack.unshift(JSON.parse(JSON.stringify({ params: json.field ? params[json.field] : params })))
                    break
                case 'pop':
                    if (stack.length === 0) return badRequest(`State ${current} attempted to pop from an empty stack`)
                    if (typeof json.collect !== 'undefined' && typeof json.collect !== 'boolean') return badRequest(`State ${current} is invalid`)
                    params = json.collect ? { params: stack.shift().params, result: params } : stack.shift().params
                    break
                case 'action':
                    if (typeof json.name !== 'string') return badRequest(`State ${current} specifies an invalid action`)
                    return { action: json.name, params, state: { $resume: { state, stack } } } // invoke continuation
                    break
                case 'literal':
                    if (typeof json.value === 'undefined') return badRequest(`State ${current} specifies an invalid value`)
                    params = json.value
                    inspect()
                    break
                case 'function':
                    if (typeof json.exec.exec !== 'string') return badRequest(`State ${current} specifies an invalid function`)
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
                    return badRequest(`State ${current} has an unknown type`)
            }
        }
    }
}
